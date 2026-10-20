import type { AppEvent, Project, Source } from '../../shared/types';
import type { Db } from '../db';
import type { LeadAi } from '../ai/types';
import type { TelegramEngine, TgChat, TgMessage } from '../telegram/types';
import { listAuthorizedProjectAccounts } from './accounts';
import { filterIncomingMessages, qualifyAndAddLeads, type ScannerDeps } from './scanner';

export interface DiscoveryDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  emit: (e: AppEvent) => void;
}

const MAX_KEYWORDS = 8;
const SEVEN_DAYS_MS = 7 * 24 * 3600_000;

function scannerDeps(deps: DiscoveryDeps): ScannerDeps {
  return deps;
}

function countActive(sources: Source[]): number {
  return sources.filter((s) => s.status === 'active').length;
}

function sourceStatusForScore(score: number, activeCount: number, workingListSize: number): Source['status'] {
  // Low bar on purpose: every message is qualified anyway, and weak sources are retired by their real lead yield.
  if (score < 15) return 'rejected';
  if (score >= 35 && activeCount < workingListSize) return 'active';
  return 'candidate';
}

async function rateAndUpsertChat(
  deps: DiscoveryDeps,
  project: Project,
  chat: TgChat,
  accountId: number,
  foundBy: string,
  activeCount: number,
): Promise<{ source: Source; activeCount: number }> {
  const existing = deps.db.findSource(project.id, chat.chatId);
  if (existing) return { source: existing, activeCount };

  const sample = await deps.engine.getHistory(accountId, chat.chatId, Date.now() - SEVEN_DAYS_MS, null, 20);
  const { score, reason: _reason } = await deps.ai.rateChat(project, chat, sample);
  let status = sourceStatusForScore(score, activeCount, project.autopilot.workingListSize);
  if (status === 'active') activeCount++;

  const source = deps.db.addSource({
    projectId: project.id,
    tgChatId: chat.chatId,
    title: chat.title,
    username: chat.username,
    kind: chat.kind,
    memberCount: chat.memberCount,
    foundBy,
    accountId,
    status,
  });
  deps.emit({ type: 'source:update', source });
  return { source, activeCount };
}

export async function discover(deps: DiscoveryDeps, projectId: number): Promise<Source[]> {
  const project = deps.db.getProject(projectId);
  const accounts = listAuthorizedProjectAccounts(deps.db, project.accountIds);
  if (accounts.length === 0) throw new Error('Подключите рабочий аккаунт Telegram');

  const keywords = project.keywords.slice(0, MAX_KEYWORDS);
  const now = Date.now();
  let activeCount = countActive(deps.db.listSources(projectId));
  const knownChatIds = new Set(deps.db.listSources(projectId).map((s) => s.tgChatId));

  for (let i = 0; i < keywords.length; i++) {
    const kw = keywords[i];
    const accountId = accounts[i % accounts.length].id;
    deps.emit({ type: 'job', projectId, stage: `Ищу источники: ${kw}`, done: false });

    try {
      const chats = await deps.engine.searchPublicChats(accountId, kw);
      const posts = await deps.engine.searchPublicPosts(accountId, kw, 30);
      const messages = await deps.engine.searchMessages(accountId, kw, now - SEVEN_DAYS_MS, 50);

      const chatMap = new Map<number, TgChat>();
      for (const c of chats) {
        if (c.kind !== 'private') chatMap.set(c.chatId, c);
      }

      const postMsgs: TgMessage[] = [...posts, ...messages];
      for (const m of postMsgs) {
        if (!chatMap.has(m.chatId) && !knownChatIds.has(m.chatId)) {
          try {
            const chat = await deps.engine.getChat(accountId, m.chatId);
            if (chat.kind !== 'private') chatMap.set(chat.chatId, chat);
          } catch (err) {
            console.error('discovery getChat', m.chatId, err);
          }
        }
      }

      for (const chat of chatMap.values()) {
        if (knownChatIds.has(chat.chatId)) continue;
        knownChatIds.add(chat.chatId);
        const { activeCount: nextActive } = await rateAndUpsertChat(deps, project, chat, accountId, kw, activeCount);
        activeCount = nextActive;
      }

      const leadCandidates: TgMessage[] = [];
      for (const m of postMsgs) {
        if (m.isOutgoing || m.text.trim().length < 15) continue;
        const src = deps.db.findSource(project.id, m.chatId);
        if (!src) continue;
        leadCandidates.push(m);
      }
      const unseen = deps.db.filterUnseen(projectId, leadCandidates);
      const bySource = new Map<number, TgMessage[]>();
      for (const m of unseen) {
        const src = deps.db.findSource(project.id, m.chatId)!;
        const list = bySource.get(src.id) ?? [];
        list.push(m);
        bySource.set(src.id, list);
      }
      for (const [sourceId, msgs] of bySource) {
        const toQualify = filterIncomingMessages(projectId, deps.db, msgs);
        await qualifyAndAddLeads(scannerDeps(deps), project, sourceId, toQualify);
        deps.db.markSeen(projectId, msgs);
      }
    } catch (err) {
      console.error('discovery keyword', kw, err);
    }

    deps.emit({ type: 'job', projectId, stage: `Ищу источники: ${kw}`, done: true });
  }

  return deps.db.listSources(projectId);
}

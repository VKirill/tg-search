import type { AppEvent, Project } from '../../shared/types';
import type { Db } from '../db';
import type { Categorizer, LeadAi } from '../ai/types';
import { todayLocal } from './limiter';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { listAuthorizedProjectAccounts } from './accounts';

export interface ScannerDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  emit: (e: AppEvent) => void;
  categorizer?: Categorizer;
}

const MIN_TEXT_LEN = 15;

export function filterIncomingMessages(projectId: number, db: Db, msgs: TgMessage[]): TgMessage[] {
  const incoming = msgs.filter((m) => !m.isOutgoing && !m.senderIsBot && m.text.trim().length >= MIN_TEXT_LEN);
  return db.filterUnseen(projectId, incoming);
}

export async function qualifyAndAddLeads(
  deps: ScannerDeps,
  project: Project,
  sourceId: number,
  messages: TgMessage[],
): Promise<number> {
  if (deps.categorizer) messages = await categorizeAndGate(deps, deps.categorizer, messages);
  if (messages.length === 0) return 0;
  const examples = deps.db.feedbackExamples(project.id);
  const quals = await deps.ai.qualify(project, messages, examples);
  const byKey = new Map(quals.map((q) => [q.key, q]));
  let added = 0;
  for (const m of messages) {
    const q = byKey.get(`${m.chatId}:${m.messageId}`);
    if (!q || q.score < 50 || q.label === 'irrelevant') continue;
    const lead = deps.db.addLead({
      projectId: project.id,
      sourceId,
      tgChatId: m.chatId,
      tgMessageId: m.messageId,
      authorUserId: m.senderUserId,
      authorName: m.senderName,
      authorUsername: m.senderUsername,
      text: m.text,
      date: m.date,
      link: m.link,
      score: q.score,
      label: q.label,
      reason: q.reason,
    });
    if (lead) {
      added++;
      deps.emit({ type: 'lead:new', lead });
    }
  }
  return added;
}

// Demand map first: each new message is classified once (globally); only probable requests go on to the
// project's qualification. Fails open: an unclassified message is qualified as before, so no lead is lost.
async function categorizeAndGate(deps: ScannerDeps, categorizer: Categorizer, messages: TgMessage[]): Promise<TgMessage[]> {
  if (messages.length === 0) return messages;
  try {
    await classifyFresh(deps.db, categorizer, messages);
  } catch (err) {
    console.error('categorize', err);
    return messages;
  }
  const probs = deps.db.requestProbs(messages);
  const threshold = Number(deps.db.getSettings().requestThreshold || 0);
  return messages.filter((m) => (probs.get(`${m.chatId}:${m.messageId}`) ?? 1) >= threshold);
}

async function classifyFresh(db: Db, categorizer: Categorizer, messages: TgMessage[]) {
  const fresh = db.filterUnclassified(messages);
  if (fresh.length === 0) return;
  const results = new Map((await categorizer.classify(db.listCategories(), fresh)).map((r) => [r.key, r]));
  const day = todayLocal(Date.now());
  for (const m of fresh) {
    const r = results.get(`${m.chatId}:${m.messageId}`);
    if (!r) continue;
    db.addClassified({
      chatId: m.chatId, messageId: m.messageId, day, date: m.date, categoryId: r.categoryId,
      categoryProb: r.categoryProb, requestProb: r.requestProb, text: m.text, link: m.link,
    });
  }
}

// Leads found before the demand map existed (or while Jev was down) get their category once
export async function categorizeLeads(deps: Pick<ScannerDeps, 'db' | 'emit'>, categorizer: Categorizer): Promise<number> {
  const leads = deps.db.leadsWithoutCategory();
  if (leads.length === 0) return 0;
  await classifyFresh(deps.db, categorizer, leads.map((l) => ({
    chatId: l.tgChatId, messageId: l.tgMessageId, date: l.date, text: l.text, senderUserId: l.authorUserId,
    senderChatId: null, senderName: l.authorName, senderUsername: l.authorUsername, senderIsBot: false, voice: null,
    photo: null, document: null, replyToMessageId: null, link: l.link, isOutgoing: false,
  })));
  let updated = 0;
  for (const l of leads) {
    const lead = deps.db.syncLeadCategory(l.id);
    if (lead.categoryId == null) continue;
    updated++;
    deps.emit({ type: 'lead:update', lead });
  }
  return updated;
}

async function fetchHistory(
  deps: ScannerDeps,
  project: Project,
  accountId: number,
  chatId: number,
  sinceMs: number,
  afterMessageId: number | null,
): Promise<TgMessage[]> {
  try {
    return await deps.engine.getHistory(accountId, chatId, sinceMs, afterMessageId, 200);
  } catch {
    if (!project.autopilot.joinIfNeeded) throw new Error('getHistory failed');
    await deps.engine.joinChat(accountId, chatId);
    return await deps.engine.getHistory(accountId, chatId, sinceMs, afterMessageId, 200);
  }
}

function pickAccountForSource(
  deps: ScannerDeps,
  project: Project,
  sourceAccountId: number | null,
  accounts: ReturnType<typeof listAuthorizedProjectAccounts>,
): { accountId: number; persistOnSource: boolean } {
  if (sourceAccountId) {
    const acc = deps.db.listAccounts().find((a) => a.id === sourceAccountId);
    if (acc?.status === 'authorized') return { accountId: sourceAccountId, persistOnSource: false };
  }
  const accountId = accounts[0]?.id;
  if (!accountId) throw new Error('Подключите рабочий аккаунт Telegram');
  return { accountId, persistOnSource: !sourceAccountId };
}

export async function scan(
  deps: ScannerDeps,
  projectId: number,
  sourceIds?: number[],
): Promise<{ checked: number; newLeads: number }> {
  const project = deps.db.getProject(projectId);
  const accounts = listAuthorizedProjectAccounts(deps.db, project.accountIds);
  if (accounts.length === 0) throw new Error('Подключите рабочий аккаунт Telegram');

  const now = Date.now();
  const freshnessMs = project.autopilot.freshnessHours * 3600_000;
  let sources = deps.db.listSources(projectId).filter((s) => s.status === 'active');
  if (sourceIds?.length) {
    const idSet = new Set(sourceIds);
    sources = sources.filter((s) => idSet.has(s.id));
  }

  let checked = 0;
  let newLeads = 0;

  for (const source of sources) {
    const { accountId, persistOnSource } = pickAccountForSource(deps, project, source.accountId, accounts);
    if (persistOnSource) {
      deps.db.updateSource(source.id, { accountId });
    }

    const since = Math.max(now - freshnessMs, source.lastScannedAt ?? 0);
    const msgs = await fetchHistory(deps, project, accountId, source.tgChatId, since, source.lastMessageId);
    const toQualify = filterIncomingMessages(projectId, deps.db, msgs);
    checked += msgs.length;

    const matched = await qualifyAndAddLeads(deps, project, source.id, toQualify);
    newLeads += matched;

    deps.db.markSeen(projectId, msgs);
    deps.db.bumpSourceStats(source.id, msgs.length, matched);

    const last = msgs[msgs.length - 1];
    deps.db.updateSource(source.id, {
      lastScannedAt: now,
      ...(last ? { lastMessageId: last.messageId } : {}),
    });
  }

  return { checked, newLeads };
}

// LeadAi over an OpenAI-compatible chat completions API.

import type { Lead, LeadLabel, Project, Settings } from '../../shared/types';
import type { TgChat, TgMessage } from '../telegram/types';
import { chatJsonCompletion } from './llm';
import {
  draftReplySystem,
  draftReplyUser,
  qualifySystem,
  qualifyUser,
  rateChatSystem,
  rateChatUser,
  suggestKeywordsSystem,
  suggestKeywordsUser,
} from './prompts';
import type { DialogTurn, FeedbackExample, LeadAi, ProjectBrief, Qualification } from './types';
const QUALIFY_CHUNK = 20;
const NO_SCORE_REASON = 'нет оценки';

function messageKey(m: TgMessage): string {
  return `${m.chatId}:${m.messageId}`;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

function normalizeLabel(raw: string): LeadLabel {
  const s = raw?.toLowerCase().trim();
  if (s === 'demand' || s === 'interest' || s === 'irrelevant') return s;
  return 'irrelevant';
}

function dedupeKeywords(words: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const k = w.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= 20) break;
  }
  return out;
}

function parseKeywordsJson(data: unknown): string[] {
  if (Array.isArray(data)) return dedupeKeywords(data.map(String));
  if (data && typeof data === 'object' && Array.isArray((data as { keywords?: unknown }).keywords)) {
    return dedupeKeywords((data as { keywords: unknown[] }).keywords.map(String));
  }
  throw new Error('Ошибка LLM: неверный формат keywords');
}

export class OpenAiLeadAi implements LeadAi {
  constructor(readonly settings: () => Settings) {}

  async suggestKeywords(brief: ProjectBrief): Promise<string[]> {
    const data = await chatJsonCompletion(this.settings, [
      { role: 'system', content: suggestKeywordsSystem() },
      { role: 'user', content: suggestKeywordsUser(brief) },
    ]);
    return parseKeywordsJson(data);
  }

  async rateChat(
    project: Project,
    chat: TgChat,
    sample: TgMessage[],
  ): Promise<{ score: number; reason: string }> {
    const data = await chatJsonCompletion(this.settings, [
      { role: 'system', content: rateChatSystem() },
      { role: 'user', content: rateChatUser(project, chat, sample) },
    ]);
    const obj = data as { score?: number; reason?: string };
    return {
      score: clampScore(Number(obj.score)),
      reason: String(obj.reason ?? '').trim() || '—',
    };
  }

  async qualify(
    project: Project,
    messages: TgMessage[],
    examples: FeedbackExample[],
  ): Promise<Qualification[]> {
    const prepared = messages.map((m) => ({
      m,
      text: m.text.trim().slice(0, 1200),
    }));
    const emptyFallback = (m: TgMessage): Qualification => ({
      key: messageKey(m),
      score: 0,
      label: 'irrelevant',
      reason: NO_SCORE_REASON,
    });

    const byKey = new Map<string, Qualification>();
    const nonEmpty = prepared.filter((x) => x.text.length > 0);
    for (let i = 0; i < nonEmpty.length; i += QUALIFY_CHUNK) {
      const chunk = nonEmpty.slice(i, i + QUALIFY_CHUNK);
      const payload = chunk.map(({ m, text }) => ({ key: messageKey(m), text }));
      const data = await chatJsonCompletion(this.settings, [
        { role: 'system', content: qualifySystem() },
        { role: 'user', content: qualifyUser(project, payload, examples) },
      ]);
      const items = (data as { items?: unknown }).items;
      const chunkByKey = new Map<string, Qualification>();
      if (Array.isArray(items)) {
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const row = it as Record<string, unknown>;
          const key = String(row.key ?? '');
          if (!key) continue;
          chunkByKey.set(key, {
            key,
            score: clampScore(Number(row.score)),
            label: normalizeLabel(String(row.label ?? '')),
            reason: String(row.reason ?? '').trim() || '—',
          });
        }
      }
      for (const { m } of chunk) {
        const key = messageKey(m);
        byKey.set(key, chunkByKey.get(key) ?? emptyFallback(m));
      }
    }
    return prepared.map(({ m, text }) =>
      text.length === 0 ? emptyFallback(m) : (byKey.get(messageKey(m)) ?? emptyFallback(m)),
    );
  }

  async draftReply(
    project: Project,
    lead: Lead,
    where: 'dm' | 'chat',
    history: DialogTurn[],
  ): Promise<string> {
    const data = await chatJsonCompletion(
      this.settings,
      [
        { role: 'system', content: draftReplySystem() },
        { role: 'user', content: draftReplyUser(project, lead, where, history) },
      ],
      { temperature: 0.6 },
    );
    const text = (data as { text?: string }).text;
    if (!text || !String(text).trim()) throw new Error('Ошибка LLM: пустой текст ответа');
    return String(text).trim();
  }
}

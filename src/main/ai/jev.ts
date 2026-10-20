// Jev qualification via TypeSafe System One (OpenLux).

import type { LeadLabel, Project, Settings } from '../../shared/types';
import type { TgMessage } from '../telegram/types';
import type { FeedbackExample, Qualification, Qualifier } from './types';
import { recordUsage } from '../usage';

const CHUNK_SIZE = 10;
const MAX_PARALLEL = 4;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 2000];
const NO_SCORE_REASON = 'нет оценки';
const MAX_TEXT = 1200;
const MAX_FEEDBACK = 8;

type ScoreAnswer = {
  type: 'score';
  probabilities?: Record<string, number>;
};

type NoulAnswer = {
  type: 'noul';
  noul?: number;
};

type SystemOneResponse = {
  answers?: Record<string, ScoreAnswer | NoulAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

function messageKey(m: TgMessage): string {
  return `${m.chatId}:${m.messageId}`;
}

function requireJevKey(settings: Settings): string {
  const key = settings.jevApiKey.trim();
  if (!key) throw new Error('Укажите ключ Jev в настройках');
  return key;
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('Retry-After');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(h);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}

function isRetryable(status: number | undefined, err: unknown): boolean {
  if (status === 429 || status === 529 || (status !== undefined && status >= 500)) return true;
  return err instanceof TypeError || (err as Error).name === 'TimeoutError';
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function fitCriteria(i: number): string[] {
  return [
    'Not a lead: off-topic, ad, or a contractor offering the same service',
    'Related topic but no clear request to hire',
    `Clear request to hire for this service; sending the author a short offer about \`messages[${i}].text\` would be appropriate`,
  ];
}

function buildQuestions(count: number): Record<string, { type: string; instructions: string; criteria?: string[] }> {
  const questions: Record<string, { type: string; instructions: string; criteria?: string[] }> = {};
  for (let i = 0; i < count; i++) {
    questions[`fit_${i}`] = {
      type: 'score',
      instructions:
        `How well does \`messages[${i}].text\` fit as a lead for this project? Follow the owner's rules in \`project.criteria\`.`,
      criteria: fitCriteria(i),
    };
    questions[`seller_${i}`] = {
      type: 'noul',
      instructions: `Is the author of \`messages[${i}].text\` offering their own services (contractor or advertiser) rather than looking to hire?`,
    };
  }
  return questions;
}

function authorLabel(m: TgMessage): string {
  if (m.senderUsername) return `@${m.senderUsername}`;
  if (m.senderName) return m.senderName;
  return 'unknown';
}

function buildState(project: Project, chunk: TgMessage[], examples: FeedbackExample[]) {
  const feedback = examples.slice(0, MAX_FEEDBACK).map((e) => ({
    text: e.text.slice(0, MAX_TEXT),
    verdict: e.verdict === 'up' ? 'relevant' : 'not relevant',
  }));
  return {
    project: {
      task: project.task,
      target: project.target,
      offer: project.offer,
      criteria: project.criteria,
      geo: project.geo,
      languages: project.languages,
    },
    feedback,
    messages: chunk.map((m) => ({
      text: m.text.trim().slice(0, MAX_TEXT),
      author: authorLabel(m),
    })),
  };
}

function prob(answer: ScoreAnswer | undefined, level: string): number {
  const p = answer?.probabilities?.[level];
  return typeof p === 'number' && Number.isFinite(p) ? p : 0;
}

function mapOne(key: string, fit: ScoreAnswer | undefined, seller: NoulAnswer | undefined): Qualification {
  if (!fit || fit.type !== 'score' || seller?.type !== 'noul') {
    return { key, score: 0, label: 'irrelevant', reason: NO_SCORE_REASON };
  }
  const p0 = prob(fit, '0');
  const p1 = prob(fit, '1');
  const p2 = prob(fit, '2');
  const sellerP = typeof seller.noul === 'number' ? seller.noul : 0;
  let score = Math.round(100 * (p2 + 0.5 * p1));
  let label: LeadLabel = 'irrelevant';
  if (sellerP >= 0.5) {
    label = 'irrelevant';
    score = Math.min(score, 20);
  } else if (p2 >= p1 && p2 >= p0) {
    label = 'demand';
  } else if (p1 >= p0) {
    label = 'interest';
  }
  score = Math.min(100, Math.max(0, score));
  const fitPct = Math.round(Math.max(p0, p1, p2) * 100);
  const sellerPct = Math.round(sellerP * 100);
  const fitWord =
    label === 'demand' ? 'запрос на услугу' : label === 'interest' ? 'интерес без запроса' : 'не лид';
  const reason = `Jev: ${fitWord} ${fitPct}% · продавец ${sellerPct}%`;
  return { key, score, label, reason };
}

export async function postSystemOne(getSettings: () => Settings, body: object): Promise<SystemOneResponse> {
  const settings = getSettings();
  const url = `${settings.jevBaseUrl.replace(/\/$/, '')}/systemone`;
  const payload = JSON.stringify({
    model: settings.jevModel || 'jev-1.14.0',
    ...body,
  });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${requireJevKey(settings)}`,
          'Content-Type': 'application/json',
        },
        body: payload,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const excerpt = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
        const err = new Error(
          `Ошибка Jev: HTTP ${res.status}${excerpt ? ` — ${excerpt}` : ''}`,
        ) as Error & { status?: number; retryAfterMs?: number | null };
        err.status = res.status;
        err.retryAfterMs = retryAfterMs(res);
        throw err;
      }
      const data = (await res.json()) as SystemOneResponse;
      recordUsage({
        kind: 'jev', model: settings.jevModel || 'jev-1.14.0', inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens, units: Object.keys((body as { questions?: object }).questions ?? {}).length,
      });
      return data;
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      if (!isRetryable(status, e) || attempt >= RETRY_DELAYS_MS.length) break;
      const after = (e as { retryAfterMs?: number | null }).retryAfterMs;
      const delay = after != null && after > 0 ? after : RETRY_DELAYS_MS[attempt];
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function qualifyChunk(
  getSettings: () => Settings,
  project: Project,
  chunk: TgMessage[],
  examples: FeedbackExample[],
): Promise<Qualification[]> {
  const state = buildState(project, chunk, examples);
  const questions = buildQuestions(chunk.length);
  const data = await postSystemOne(getSettings, { state, questions });
  const answers = data.answers ?? {};
  return chunk.map((m, i) => {
    const key = messageKey(m);
    const text = m.text.trim().slice(0, MAX_TEXT);
    if (!text) {
      return { key, score: 0, label: 'irrelevant' as const, reason: NO_SCORE_REASON };
    }
    return mapOne(key, answers[`fit_${i}`] as ScoreAnswer, answers[`seller_${i}`] as NoulAnswer);
  });
}

export async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

export class JevQualifier implements Qualifier {
  constructor(private readonly getSettings: () => Settings) {}

  async qualify(project: Project, messages: TgMessage[], examples: FeedbackExample[]): Promise<Qualification[]> {
    requireJevKey(this.getSettings());
    const prepared = messages.map((m) => ({ m, text: m.text.trim().slice(0, MAX_TEXT) }));
    const empty = (m: TgMessage): Qualification => ({
      key: messageKey(m),
      score: 0,
      label: 'irrelevant',
      reason: NO_SCORE_REASON,
    });
    const nonEmpty = prepared.filter((x) => x.text.length > 0);
    const chunks: TgMessage[][] = [];
    for (let i = 0; i < nonEmpty.length; i += CHUNK_SIZE) {
      chunks.push(nonEmpty.slice(i, i + CHUNK_SIZE).map((x) => x.m));
    }
    const chunkResults = await mapPool(chunks, MAX_PARALLEL, (chunk) =>
      qualifyChunk(this.getSettings, project, chunk, examples),
    );
    const byKey = new Map<string, Qualification>();
    for (const part of chunkResults) {
      for (const q of part) byKey.set(q.key, q);
    }
    return prepared.map(({ m, text }) => (text.length === 0 ? empty(m) : (byKey.get(messageKey(m)) ?? empty(m))));
  }
}

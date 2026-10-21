import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { chatJsonCompletion } from '../ai/llm';
import { recordUsage } from '../usage';
import type { LlmOverride } from '../ai/llm';
import type { DialogTurn } from '../ai/types';
import type { OrderFile, Service, Settings } from '../../shared/types';
import { llmGateway } from '../ai/gateway';
import type { ModelRole } from '../opencode/models';
import type { ExecutorInput } from './types';

export const DEFAULT_VISION_MODEL = 'anthropic/claude-sonnet-5.5';

const LLM_REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [500, 2000];

export function executorLlmOverride(service: Service): LlmOverride | undefined {
  const m = service.model?.trim();
  return m ? { model: m } : undefined;
}

export function visionModel(service: Service): string {
  return service.model?.trim() || DEFAULT_VISION_MODEL;
}

export function formatDialog(history: DialogTurn[]): string {
  return history.map((t) => `${t.direction === 'in' ? 'Клиент' : 'Мы'}: ${t.text}`).join('\n');
}

export function clampPrice(service: Service, price: number): number {
  const n = Math.round(Number(price));
  if (!Number.isFinite(n)) return service.priceMin;
  return Math.min(service.priceMax, Math.max(service.priceMin, n));
}

export async function estimatePrice(
  getSettings: () => Settings,
  input: ExecutorInput,
): Promise<{ price: number; reason: string }> {
  const { service, order, history } = input;
  const dialog = formatDialog(history);
  const raw = await chatJsonCompletion(
    getSettings,
    [
      {
        role: 'system',
        content:
          'Ты оцениваешь сложность заказа и называешь цену в рублях внутри допустимой вилки. Ответ — только JSON: {"price": number, "reason": "одна короткая строка для владельца на русском"}.',
      },
      {
        role: 'user',
        content:
          `Услуга: ${service.name}\nИнструкция исполнителя:\n${service.instructions}\n\n` +
          `Вилка цены: ${service.priceMin}–${service.priceMax} ₽\n\nБриф и допущения:\n${order.brief}\n\nДиалог:\n${dialog || '(пусто)'}`,
      },
    ],
    {},
    executorLlmOverride(service),
  );
  const obj = raw as { price?: unknown; reason?: unknown };
  const price = clampPrice(service, Number(obj.price));
  const reason = String(obj.reason ?? '').trim() || 'Оценка по брифу и диалогу';
  return { price, reason };
}

export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type VisionMessage = { role: 'system' | 'user' | 'assistant'; content: string | VisionContentPart[] };

function isRetryableHttp(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function visionChat(
  getSettings: () => Settings,
  messages: VisionMessage[],
  service: Service,
  role: ModelRole = 'vision',
): Promise<string> {
  const gw = llmGateway();
  if (gw) {
    const textOf = (c: VisionMessage['content']) => (typeof c === 'string' ? c : c.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n'));
    const images = messages.flatMap((m) => (typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image_url').map((p) => (p as { image_url: { url: string } }).image_url.url)));
    return gw.complete({
      role,
      system: messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n'),
      messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', text: textOf(m.content) })),
      images,
      title: service.name,
    });
  }
  const base = getSettings();
  const override = executorLlmOverride(service);
  const settings: Settings = {
    ...base,
    llmModel: override?.model?.trim() || visionModel(service),
    llmApiKey: override?.apiKey?.trim() || base.llmApiKey,
    llmBaseUrl: override?.baseUrl?.trim() || base.llmBaseUrl,
  };
  const key = settings.llmApiKey.trim();
  if (!key) throw new Error('Укажите ключ LLM в настройках');

  const url = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.llmModel,
    messages,
    temperature: 0.2,
  };
  if (settings.llmBaseUrl.includes('openrouter.ai')) body.usage = { include: true };

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/VKirill/tg-search',
          'X-Title': 'TG Search',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const excerpt = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
        const err = new Error(`Ошибка LLM: HTTP ${res.status}${excerpt ? ` — ${excerpt}` : ''}`) as Error & {
          status?: number;
        };
        err.status = res.status;
        throw err;
      }
      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      recordUsage({
        kind: 'llm', model: settings.llmModel, inputTokens: data.usage?.prompt_tokens,
        outputTokens: data.usage?.completion_tokens, costUsd: data.usage?.cost ?? 0,
      });
      const content = data.choices?.[0]?.message?.content;
      if (content == null || content === '') throw new Error('Ошибка LLM: пустой ответ');
      return content;
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const retryable =
        status !== undefined ? isRetryableHttp(status) : e instanceof TypeError || (e as Error).name === 'TimeoutError';
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function inputImagePaths(input: ExecutorInput): string[] {
  return input.inputs.filter((f) => f.mime.startsWith('image/')).map((f) => f.path);
}

export function requireInputPhotos(input: ExecutorInput, message: string): string[] {
  const paths = inputImagePaths(input);
  if (!paths.length) throw new Error(message);
  return paths;
}

export async function packageTextOutput(
  workDir: string,
  text: string,
  role: 'output' | 'preview',
  fileBase = role === 'preview' ? 'preview' : 'result',
): Promise<{ text: string; files: OrderFile[] }> {
  const files: OrderFile[] = [];
  if (text.length > 3500) {
    await mkdir(workDir, { recursive: true });
    const path = join(workDir, `${fileBase}.md`);
    await writeFile(path, text, 'utf8');
    files.push({ path, role, name: basename(path), mime: 'text/markdown' });
  }
  return { text, files };
}

export function parseCountFromBrief(brief: string, fallback: number): number {
  const m = brief.match(/(\d+)\s*(?:изображен|картин|фото|образ)/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 20) return n;
  }
  return fallback;
}

export function briefWantsContentPlan(brief: string): boolean {
  return /контент[-\s]?план|недел|7\s*пост/i.test(brief);
}

export function briefWantsCovers(brief: string): boolean {
  return /обложк|cover/i.test(brief) || briefWantsContentPlan(brief);
}

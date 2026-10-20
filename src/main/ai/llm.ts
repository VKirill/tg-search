// OpenAI-compatible chat completions client (global fetch).

import type { Settings } from '../../shared/types';

export type LlmMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type ChatCompletionOptions = {
  temperature?: number;
  jsonObject?: boolean;
};

/** Per-call LLM endpoint; empty fields fall back to global Settings. */
export type LlmOverride = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

function settingsWithOverride(getSettings: () => Settings, override?: LlmOverride): Settings {
  if (!override) return getSettings();
  const s = getSettings();
  return {
    ...s,
    llmBaseUrl: override.baseUrl?.trim() || s.llmBaseUrl,
    llmApiKey: override.apiKey?.trim() || s.llmApiKey,
    llmModel: override.model?.trim() || s.llmModel,
  };
}

const REQUEST_TIMEOUT_MS = 60_000;
const RETRY_DELAYS_MS = [500, 2000];
const ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/VKirill/tg-search',
  'X-Title': 'TG Search',
};

export function parseJsonFromLlm(raw: string): unknown {
  let s = raw.trim();
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function requireApiKey(settings: Settings): string {
  const key = settings.llmApiKey.trim();
  if (!key) throw new Error('Укажите ключ LLM в настройках');
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

function isRetryableHttp(status: number): boolean {
  return status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function postChatCompletion(
  settings: Settings,
  messages: LlmMessage[],
  options: ChatCompletionOptions,
): Promise<string> {
  const url = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.llmModel,
    messages,
    temperature: options.temperature ?? 0.2,
  };
  if (options.jsonObject) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${requireApiKey(settings)}`,
      'Content-Type': 'application/json',
      ...ATTRIBUTION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const excerpt = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
    const err = new Error(
      `Ошибка LLM: HTTP ${res.status}${excerpt ? ` — ${excerpt}` : ''}`,
    ) as Error & { status?: number; retryAfterMs?: number | null };
    err.status = res.status;
    err.retryAfterMs = retryAfterMs(res);
    throw err;
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string | null } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (content == null || content === '') {
    throw new Error('Ошибка LLM: пустой ответ');
  }
  return content;
}

export async function chatCompletion(
  getSettings: () => Settings,
  messages: LlmMessage[],
  options: ChatCompletionOptions = {},
  override?: LlmOverride,
): Promise<string> {
  const settings = settingsWithOverride(getSettings, override);
  requireApiKey(settings);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await postChatCompletion(settings, messages, options);
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const retryable =
        status !== undefined
          ? isRetryableHttp(status)
          : e instanceof TypeError || (e as Error).name === 'TimeoutError';
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
      const after = (e as { retryAfterMs?: number | null }).retryAfterMs;
      const delay = after != null && after > 0 ? after : RETRY_DELAYS_MS[attempt];
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function chatJsonCompletion(
  getSettings: () => Settings,
  messages: LlmMessage[],
  options: ChatCompletionOptions = {},
  override?: LlmOverride,
): Promise<unknown> {
  const opts = { ...options, jsonObject: true };
  const text = await chatCompletion(getSettings, messages, opts, override);
  try {
    return parseJsonFromLlm(text);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    const retryText = await chatCompletion(getSettings, messages, opts, override);
    return parseJsonFromLlm(retryText);
  }
}

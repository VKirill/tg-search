// OpenAI-compatible chat completions with function calling (DeepSeek, OpenRouter, etc.).

import type { ManagerSettings, Settings } from '../../shared/types';
import { recordUsage } from '../usage';
import { resolveOperator } from './provider';

export type ToolCall = { id: string; name: string; arguments: string };

export type AgentChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type AgentToolDef = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type AgentCompletionResult = {
  message: { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
  usageCostUsd: number;
};

export type OperatorLlmOverride = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
};

const REQUEST_TIMEOUT_MS = 90_000;
const RETRY_DELAYS_MS = [500, 2000];
const ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/VKirill/tg-search',
  'X-Title': 'TG Search',
};

function operatorSettings(getSettings: () => Settings, mgr?: ManagerSettings, override?: OperatorLlmOverride): Settings {
  const s = getSettings();
  const m = mgr ?? { baseUrl: '', apiKey: '', model: '' };
  // Precedence: explicit override → the project's manager model → the provider switch (GLM / DeepSeek / custom) → global LLM
  const op = resolveOperator(s);
  return {
    ...s,
    llmBaseUrl: override?.baseUrl?.trim() || m.baseUrl?.trim() || op.baseUrl.trim() || s.llmBaseUrl,
    llmApiKey: override?.apiKey?.trim() || m.apiKey?.trim() || op.apiKey.trim() || s.llmApiKey,
    llmModel: override?.model?.trim() || m.model?.trim() || op.model.trim() || s.llmModel,
  };
}

function requireApiKey(settings: Settings): string {
  const key = settings.llmApiKey.trim();
  if (!key) throw new Error('Укажите ключ оператора в настройках');
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

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: ToolCall[] = [];
  for (const t of raw) {
    const o = t as { id?: string; type?: string; function?: { name?: string; arguments?: string } };
    if (o.type !== 'function' || !o.id || !o.function?.name) continue;
    out.push({ id: o.id, name: o.function.name, arguments: o.function.arguments ?? '{}' });
  }
  return out.length ? out : undefined;
}

function toApiMessage(m: AgentChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  }
  if (m.role === 'assistant' && m.tool_calls?.length) {
    return {
      role: 'assistant',
      content: m.content,
      tool_calls: m.tool_calls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content ?? '' };
}

async function postOnce(
  settings: Settings,
  messages: AgentChatMessage[],
  tools: AgentToolDef[],
): Promise<AgentCompletionResult> {
  const url = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model: settings.llmModel,
    messages: messages.map(toApiMessage),
    tools,
    tool_choice: 'auto',
    temperature: 0.3,
    thinking: { type: 'disabled' },
  };
  if (settings.llmBaseUrl.includes('openrouter.ai')) body.usage = { include: true };

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
    choices?: { message?: { content?: string | null; tool_calls?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  const costUsd = data.usage?.cost ?? 0;
  recordUsage({
    kind: 'llm',
    model: settings.llmModel,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
    costUsd,
  });

  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('Ошибка LLM: пустой ответ');
  const tool_calls = parseToolCalls(msg.tool_calls);
  return {
    message: { role: 'assistant', content: msg.content ?? null, tool_calls },
    usageCostUsd: costUsd,
  };
}

export async function agentChatCompletion(
  getSettings: () => Settings,
  messages: AgentChatMessage[],
  tools: AgentToolDef[],
  mgr?: ManagerSettings,
  override?: OperatorLlmOverride,
): Promise<AgentCompletionResult> {
  const settings = operatorSettings(getSettings, mgr, override);
  requireApiKey(settings);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await postOnce(settings, messages, tools);
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

// Running turns in OpenCode sessions: prompt, wait for the turn to end (an «idle» message after our prompt), read
// the assistant's text. A one-shot helper (a throwaway session with the tool-less agent) replaces every direct
// chat-completions call in the app.
import type { OpencodeServer } from './server';
import type { Bridge, SessionBinding } from './bridge';

export interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

export interface TurnResult {
  outcome: 'succeeded' | 'failed' | 'interrupted' | 'timeout';
  text: string; // the last assistant text of the turn
  error: string | null;
  costUsd: number;
}

interface Message {
  id: string;
  type: string;
  outcome?: string;
  error?: { message?: string };
  content?: { type: string; text?: string }[];
  cost?: number;
}

export const ONESHOT_AGENT = 'tgs-oneshot';

export function createSessions(server: OpencodeServer, bridge: Bridge) {
  async function create(opts: { agent: string; model: ModelRef; title: string; parentID?: string }): Promise<string> {
    const res = await server.call<{ data: { id: string } }>('POST', '/api/session', {
      title: opts.title,
      agent: opts.agent,
      model: { id: opts.model.id, providerID: opts.model.providerID, ...(opts.model.variant ? { variant: opts.model.variant } : {}) },
      location: { directory: server.workDir() },
      ...(opts.parentID ? { parentID: opts.parentID } : {}),
    });
    return res.data.id;
  }

  async function setModel(sessionID: string, model: ModelRef) {
    await server.call('POST', `/api/session/${sessionID}/model`, {
      model: { id: model.id, providerID: model.providerID, ...(model.variant ? { variant: model.variant } : {}) },
    });
  }

  async function remove(sessionID: string) {
    await server.call('DELETE', `/api/session/${sessionID}`).catch(() => {});
  }

  async function messagesAfter(sessionID: string, afterId: string): Promise<Message[]> {
    const res = await server.call<{ data: Message[] }>('GET', `/api/session/${sessionID}/message?limit=50&order=desc`);
    const out: Message[] = [];
    for (const m of res.data) {
      if (m.id === afterId) break;
      out.push(m);
    }
    return out.reverse(); // oldest first
  }

  // One turn: the binding tells the bridge which dialog the session's tool calls belong to
  async function runTurn(sessionID: string, prompt: { text: string; files?: string[] }, binding: SessionBinding | null, timeoutMs = 5 * 60_000): Promise<TurnResult> {
    if (binding) bridge.bind(sessionID, binding);
    try {
      const sent = await server.call<{ data: { id: string } }>('POST', `/api/session/${sessionID}/prompt`, {
        text: prompt.text,
        ...(prompt.files?.length ? { files: prompt.files.map((uri, i) => ({ uri, name: `image-${i + 1}` })) } : {}),
        delivery: 'queue',
      });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 700));
        const after = await messagesAfter(sessionID, sent.data.id);
        const idle = after.find((m) => m.type === 'idle');
        if (!idle) continue;
        const assistants = after.filter((m) => m.type === 'assistant');
        const texts = assistants.flatMap((m) => (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? ''));
        return {
          outcome: (idle.outcome as TurnResult['outcome']) ?? 'succeeded',
          text: texts.filter((t) => t.trim()).pop()?.trim() ?? '',
          error: idle.error?.message ?? assistants.map((m) => m.error?.message).find(Boolean) ?? null,
          costUsd: assistants.reduce((s, m) => s + (m.cost ?? 0), 0),
        };
      }
      await server.call('POST', `/api/session/${sessionID}/interrupt`).catch(() => {});
      return { outcome: 'timeout', text: '', error: 'модель не ответила вовремя', costUsd: 0 };
    } finally {
      if (binding) bridge.unbind(sessionID);
    }
  }

  // A single request without tools — what used to be a direct chat-completions call
  async function oneShot(opts: { model: ModelRef; text: string; files?: string[]; title?: string; timeoutMs?: number }): Promise<string> {
    const sessionID = await create({ agent: ONESHOT_AGENT, model: opts.model, title: opts.title ?? 'one-shot' });
    try {
      const r = await runTurn(sessionID, { text: opts.text, files: opts.files }, null, opts.timeoutMs ?? 3 * 60_000);
      if (r.outcome !== 'succeeded' || !r.text) throw new Error(`Модель ${opts.model.providerID}/${opts.model.id}: ${r.error ?? 'пустой ответ'}`);
      return r.text;
    } finally {
      void remove(sessionID);
    }
  }

  return { create, setModel, remove, runTurn, oneShot };
}

export type Sessions = ReturnType<typeof createSessions>;

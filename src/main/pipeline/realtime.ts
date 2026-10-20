import type { Source } from '../../shared/types';
import type { SpeechService } from '../ai/speech';
import type { TgMessage } from '../telegram/types';
import { transcribeIncomingVoice } from '../voice/incoming';
import {
  filterIncomingMessages,
  qualifyAndAddLeads,
  type ScannerDeps,
} from './scanner';

export interface RealtimeDeps extends ScannerDeps {
  speech?: SpeechService;
  dataDir?: string;
}

const FLUSH_MS = 3000;
const FLUSH_MAX = 20;

type Buffered = { msg: TgMessage; sourceId: number };

const MAX_VOICE_SEC = 90;

export function createRealtime(deps: RealtimeDeps) {
  const buffers = new Map<number, Map<string, Buffered>>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function clearTimer(projectId: number) {
    const t = timers.get(projectId);
    if (t) clearTimeout(t);
    timers.delete(projectId);
  }

  // Failed batches stay unseen, so the periodic scan picks them up later.
  function flush(projectId: number) {
    flushProject(projectId).catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error('realtime flush', projectId, err);
      deps.emit({ type: 'job', projectId, stage: 'Проверка новых сообщений', done: true, error });
    });
  }

  async function flushProject(projectId: number) {
    clearTimer(projectId);
    const buf = buffers.get(projectId);
    if (!buf || buf.size === 0) return;
    buffers.set(projectId, new Map());

    const project = deps.db.getProject(projectId);
    const bySource = new Map<number, TgMessage[]>();
    for (const { msg, sourceId } of buf.values()) {
      const list = bySource.get(sourceId) ?? [];
      list.push(msg);
      bySource.set(sourceId, list);
    }

    for (const [sourceId, msgs] of bySource) {
      const toQualify = filterIncomingMessages(projectId, deps.db, msgs);
      const matched = await qualifyAndAddLeads(deps, project, sourceId, toQualify);
      deps.db.markSeen(projectId, msgs);
      deps.db.bumpSourceStats(sourceId, msgs.length, matched);
      const maxId = msgs.reduce((a, m) => Math.max(a, m.messageId), 0);
      if (maxId > 0) deps.db.updateSource(sourceId, { lastMessageId: maxId });
    }
  }

  function scheduleFlush(projectId: number) {
    clearTimer(projectId);
    timers.set(
      projectId,
      setTimeout(() => {
        flush(projectId);
      }, FLUSH_MS),
    );
  }

  // Every group, supergroup and channel the account is in is a source of each project the account works for.
  // A chat becomes a source with its first message; a source the user rejected is not listened to.
  const pendingChats = new Map<string, Promise<Source | null>>();

  async function sourceFor(projectId: number, accountId: number, chatId: number): Promise<Source | null> {
    const existing = deps.db.findSource(projectId, chatId);
    if (existing) return existing.status === 'rejected' ? null : existing;
    const key = `${projectId}:${chatId}`;
    let pending = pendingChats.get(key);
    if (!pending) {
      pending = deps.engine
        .getChat(accountId, chatId)
        .then((chat) => {
          const source = deps.db.addSource({
            projectId, tgChatId: chat.chatId, title: chat.title, username: chat.username, kind: chat.kind,
            memberCount: chat.memberCount, foundBy: 'member', accountId, status: 'active',
          });
          deps.emit({ type: 'source:update', source });
          return source.status === 'rejected' ? null : source;
        })
        .finally(() => pendingChats.delete(key));
      pendingChats.set(key, pending);
    }
    return pending;
  }

  async function bufferMessage(accountId: number, msg: TgMessage) {
    const projects = deps.db
      .listProjects()
      .filter((p) => p.accountIds.length === 0 || p.accountIds.includes(accountId));

    const key = `${msg.chatId}:${msg.messageId}`;
    for (const project of projects) {
      const source = await sourceFor(project.id, accountId, msg.chatId);
      if (!source) continue;
      let buf = buffers.get(project.id);
      if (!buf) {
        buf = new Map();
        buffers.set(project.id, buf);
      }
      if (!buf.has(key)) buf.set(key, { msg, sourceId: source.id });
      if (buf.size >= FLUSH_MAX) flush(project.id);
      else scheduleFlush(project.id);
    }
  }

  async function onVoiceMessage(accountId: number, msg: TgMessage) {
    if (!deps.speech || !deps.dataDir || !msg.voice || msg.voice.durationSec > MAX_VOICE_SEC) return;
    const projects = deps.db
      .listProjects()
      .filter((p) => p.accountIds.length === 0 || p.accountIds.includes(accountId));
    const projectId = projects[0]?.id ?? null;
    const { text } = await transcribeIncomingVoice({
      dataDir: deps.dataDir,
      engine: deps.engine,
      speech: deps.speech,
      accountId,
      msg,
      emit: projectId != null ? deps.emit : undefined,
      projectId: projectId ?? undefined,
    });
    await bufferMessage(accountId, { ...msg, text });
  }

  async function onChatMessage(accountId: number, msg: TgMessage) {
    if (msg.isOutgoing) return;
    if (msg.senderIsBot) return;
    if (msg.voice) return;
    if (msg.text.trim().length < 15) return;
    await bufferMessage(accountId, msg);
  }

  return {
    start() {
      deps.engine.onChatMessage((accountId, msg) => {
        if (msg.voice && !msg.isOutgoing) {
          onVoiceMessage(accountId, msg).catch((err) => console.error('realtime voice', msg.chatId, err));
          return;
        }
        onChatMessage(accountId, msg).catch((err) => console.error('realtime message', msg.chatId, err));
      });
    },
    stop() {
      for (const projectId of timers.keys()) clearTimer(projectId);
      buffers.clear();
    },
  };
}

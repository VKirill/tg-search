import type { AppEvent, Broadcast, BroadcastChat, BroadcastInput } from '../../shared/types';
import type { TextSpinner } from '../ai/types';
import type { Db } from '../db';
import type { TelegramEngine } from '../telegram/types';
import { afterSend, canSend } from './limiter';

export interface BroadcasterDeps {
  db: Db;
  engine: TelegramEngine;
  spinner: TextSpinner;
  emit: (e: AppEvent) => void;
}

export interface RunNowResult {
  posted: number;
  skipped: number;
  errors: number;
}

export interface Broadcaster {
  create(input: BroadcastInput): Promise<Broadcast>;
  update(id: number, patch: Partial<BroadcastInput> & { enabled?: boolean }): Promise<Broadcast>;
  remove(id: number): Promise<void>;
  runNow(id: number): Promise<RunNowResult>;
  start(): void;
  stop(): void;
  tick(now?: number): Promise<void>;
}

function validateInput(input: BroadcastInput): void {
  if (!input.name?.trim()) throw new Error('Укажите название рассылки');
  if (!input.text?.trim()) throw new Error('Укажите текст рассылки');
  if (!input.accountIds?.length) throw new Error('Выберите хотя бы один аккаунт');
  if (!input.chatLinks?.length) throw new Error('Добавьте хотя бы один чат');
  if (!Number.isFinite(input.intervalHours) || input.intervalHours < 1) {
    throw new Error('Интервал должен быть не меньше 1 часа');
  }
}

function firstAuthorizedAccountId(db: Db, accountIds: number[]): number {
  for (const id of accountIds) {
    const a = db.getAccount(id);
    if (a.status === 'authorized') return id;
  }
  throw new Error('Подключите хотя бы один рабочий аккаунт из списка');
}

async function resolveChatLinks(
  engine: TelegramEngine,
  accountId: number,
  links: string[],
): Promise<BroadcastChat[]> {
  const failed: string[] = [];
  const chats: BroadcastChat[] = [];
  const seen = new Set<number>();
  for (const link of links) {
    try {
      const tg = await engine.resolveChat(accountId, link);
      if (seen.has(tg.chatId)) continue;
      seen.add(tg.chatId);
      chats.push({
        tgChatId: tg.chatId,
        title: tg.title,
        username: tg.username,
        lastPostedAt: null,
        lastError: null,
      });
    } catch {
      failed.push(link);
    }
  }
  if (failed.length) throw new Error(`Не удалось найти чаты: ${failed.join(', ')}`);
  return chats;
}

function jitterMs(chatId: number, lastPostedAt: number, intervalMs: number): number {
  let h = chatId ^ (lastPostedAt | 0);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  const fraction = (h >>> 0) / 0x1_0000_0000;
  return Math.floor(fraction * 0.15 * intervalMs);
}

export function isChatDue(chat: BroadcastChat, intervalHours: number, now: number): boolean {
  if (chat.lastPostedAt == null) return true;
  const intervalMs = intervalHours * 3_600_000;
  const required = intervalMs + jitterMs(chat.tgChatId, chat.lastPostedAt, intervalMs);
  return now - chat.lastPostedAt >= required;
}

function isJoinRetryError(message: string): boolean {
  const s = message.toLowerCase();
  return (
    s.includes('not a member')
    || s.includes('chat_write_forbidden')
    || s.includes('must join')
    || s.includes('не участник')
  );
}

export function createBroadcaster(deps: BroadcasterDeps): Broadcaster {
  const rotation = new Map<number, number>();
  // Last failed attempt per `${broadcastId}:${chatId}`: a failing chat waits a full interval like a posted one,
  // instead of hitting Telegram and the LLM on every tick.
  const failedAt = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | null = null;

  function rotationIndex(broadcastId: number): number {
    return rotation.get(broadcastId) ?? 0;
  }

  function advanceRotation(broadcastId: number, accountIds: number[], usedAccountId: number): void {
    const idx = accountIds.indexOf(usedAccountId);
    if (idx >= 0) rotation.set(broadcastId, (idx + 1) % accountIds.length);
    else rotation.set(broadcastId, (rotationIndex(broadcastId) + 1) % accountIds.length);
  }

  function pickAccount(
    broadcast: Broadcast,
    now: number,
    usedThisTick: Set<number>,
  ): number | null {
    const ids = broadcast.accountIds;
    const start = rotationIndex(broadcast.id);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[(start + i) % ids.length];
      if (usedThisTick.has(id)) continue;
      const a = deps.db.getAccount(id);
      if (a.status !== 'authorized') continue;
      if (!canSend(a, now).ok) continue;
      return id;
    }
    return null;
  }

  async function postToChat(
    broadcast: Broadcast,
    chat: BroadcastChat,
    accountId: number,
    text: string,
  ): Promise<void> {
    try {
      await deps.engine.sendToChat(accountId, chat.tgChatId, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isJoinRetryError(msg)) throw err;
      const isPublic = chat.username != null;
      if (!isPublic) {
        try {
          const tg = await deps.engine.getChat(accountId, chat.tgChatId);
          if (!tg.username) throw err;
        } catch {
          throw err;
        }
      }
      await deps.engine.joinChat(accountId, chat.tgChatId);
      await deps.engine.sendToChat(accountId, chat.tgChatId, text);
    }
  }

  async function processBroadcast(
    broadcast: Broadcast,
    now: number,
    usedThisTick: Set<number>,
  ): Promise<RunNowResult> {
    const result: RunNowResult = { posted: 0, skipped: 0, errors: 0 };
    let current = deps.db.getBroadcast(broadcast.id);

    for (const chat of current.chats) {
      const failed = failedAt.get(`${current.id}:${chat.tgChatId}`);
      const lastAttempt = Math.max(chat.lastPostedAt ?? 0, failed ?? 0) || null;
      if (!isChatDue({ ...chat, lastPostedAt: lastAttempt }, current.intervalHours, now)) {
        result.skipped++;
        continue;
      }

      const accountId = pickAccount(current, now, usedThisTick);
      if (accountId == null) {
        result.skipped++;
        continue;
      }

      let text = current.text;
      if (current.spin) {
        try {
          text = await deps.spinner.spin(current.text);
        } catch {
          text = current.text;
        }
      }

      try {
        await postToChat(current, chat, accountId, text);
        usedThisTick.add(accountId);
        const account = deps.db.getAccount(accountId);
        const patched = deps.db.updateAccount(accountId, afterSend(account, now));
        deps.emit({ type: 'account:update', account: patched });
        current = deps.db.updateBroadcastChat(current.id, chat.tgChatId, {
          lastPostedAt: now,
          lastError: null,
        });
        deps.emit({ type: 'broadcast:update', broadcast: current });
        advanceRotation(current.id, current.accountIds, accountId);
        result.posted++;
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        failedAt.set(`${current.id}:${chat.tgChatId}`, now);
        current = deps.db.updateBroadcastChat(current.id, chat.tgChatId, { lastError: error });
        deps.emit({ type: 'broadcast:update', broadcast: current });
        result.errors++;
      }
    }

    return result;
  }

  return {
    async create(input) {
      validateInput(input);
      const accountId = firstAuthorizedAccountId(deps.db, input.accountIds);
      const chats = await resolveChatLinks(deps.engine, accountId, input.chatLinks);
      const broadcast = deps.db.createBroadcast({
        name: input.name.trim(),
        text: input.text,
        accountIds: input.accountIds,
        chats,
        intervalHours: input.intervalHours,
        spin: input.spin,
      });
      deps.emit({ type: 'broadcast:update', broadcast });
      return broadcast;
    },

    async update(id, patch) {
      const cur = deps.db.getBroadcast(id);
      const name = patch.name ?? cur.name;
      const text = patch.text ?? cur.text;
      const accountIds = patch.accountIds ?? cur.accountIds;
      const intervalHours = patch.intervalHours ?? cur.intervalHours;
      const spin = patch.spin ?? cur.spin;
      if (!name.trim()) throw new Error('Укажите название рассылки');
      if (!text.trim()) throw new Error('Укажите текст рассылки');
      if (!accountIds.length) throw new Error('Выберите хотя бы один аккаунт');
      if (!Number.isFinite(intervalHours) || intervalHours < 1) {
        throw new Error('Интервал должен быть не меньше 1 часа');
      }

      let chats = cur.chats;
      if (patch.chatLinks) {
        if (!patch.chatLinks.length) throw new Error('Добавьте хотя бы один чат');
        const accountId = firstAuthorizedAccountId(deps.db, accountIds);
        const resolved = await resolveChatLinks(deps.engine, accountId, patch.chatLinks);
        const prev = new Map(cur.chats.map((c) => [c.tgChatId, c]));
        chats = resolved.map((c) => {
          const old = prev.get(c.tgChatId);
          return old
            ? { ...c, lastPostedAt: old.lastPostedAt, lastError: old.lastError }
            : c;
        });
      }

      const broadcast = deps.db.updateBroadcast(id, {
        name,
        text,
        accountIds,
        chats,
        intervalHours,
        spin,
        enabled: patch.enabled ?? cur.enabled,
      });
      deps.emit({ type: 'broadcast:update', broadcast });
      return broadcast;
    },

    async remove(id) {
      deps.db.removeBroadcast(id);
      rotation.delete(id);
    },

    async runNow(id) {
      const broadcast = deps.db.getBroadcast(id);
      const used = new Set<number>();
      return processBroadcast(broadcast, Date.now(), used);
    },

    async tick(now = Date.now()) {
      const used = new Set<number>();
      for (const b of deps.db.listBroadcasts()) {
        if (!b.enabled) continue;
        await processBroadcast(b, now, used);
      }
    },

    start() {
      if (timer) return;
      timer = setInterval(() => {
        this.tick().catch((err) => console.error('broadcast tick', err));
      }, 60_000);
      timer.unref();
    },

    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

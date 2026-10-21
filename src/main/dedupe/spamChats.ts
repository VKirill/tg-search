// Spam chats: a chat whose latest messages are nothing but campaigns, repeats and posts on behalf of the chat itself —
// or that has had no new text for a week — is left on every account and blocked: it cannot be joined or added again.
import type { AppEvent, SpamChat } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { fingerprintText, isSameTemplate } from './fingerprint';
import { ensureDedupeSchema } from './schema';

const SAMPLE = 100; // latest messages fetched from Telegram per check
const DEAD_AFTER_MS = 7 * 86400_000; // no new text for a week: dead
const MIN_MESSAGES = 20; // judge spam only on a real sample
const MAX_LIVE_SHARE = 0.2;
const SPAM_AUTHORS = 3; // one text from this many authors is a campaign
const REPEAT_COPIES = 3; // one text posted this many times is a repeat
export const SPAM_CHAT_CHECK_MS = 6 * 3600_000;

export interface ChatHealth {
  messages: number; // text messages in the sample
  live: number; // a person's own text, not a campaign, not a repeat
  newest: number | null; // unix ms of the newest text
}

// Spun or copied texts are grouped by single linkage; posts on behalf of a chat or channel are never live
export function assessMessages(messages: TgMessage[]): ChatHealth {
  const texts = messages.filter((m) => m.text.trim() && !m.isOutgoing);
  const fps = texts.map((m) => fingerprintText(m.text));
  const group = texts.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      if (root(i) !== root(j) && isSameTemplate(fps[i], fps[j])) group[root(j)] = root(i);
    }
  }
  const copies = new Map<number, number>();
  const authors = new Map<number, Set<number>>();
  texts.forEach((m, i) => {
    const r = root(i);
    copies.set(r, (copies.get(r) ?? 0) + 1);
    if (m.senderUserId != null) authors.set(r, (authors.get(r) ?? new Set()).add(m.senderUserId));
  });
  const live = texts.filter((m, i) => {
    const r = root(i);
    return m.senderUserId != null && copies.get(r)! < REPEAT_COPIES && (authors.get(r)?.size ?? 0) < SPAM_AUTHORS;
  }).length;
  const newest = texts.length ? Math.max(...texts.map((m) => m.date)) : null;
  return { messages: texts.length, live, newest };
}

export function spamVerdict(h: ChatHealth, now = Date.now()): string | null {
  if (h.newest == null || now - h.newest > DEAD_AFTER_MS) return 'нет новых сообщений за неделю';
  if (h.messages >= MIN_MESSAGES && h.live / h.messages < MAX_LIVE_SHARE) {
    return `${h.messages - h.live} из ${h.messages} последних сообщений — спам и повторы`;
  }
  return null;
}

type SpamChatRow = {
  tg_chat_id: number; title: string; username: string | null; reason: string; messages: number; live_share: number;
  source: string; created_at: number;
};

function toSpamChat(r: SpamChatRow): SpamChat {
  return {
    tgChatId: r.tg_chat_id, title: r.title, username: r.username, reason: r.reason, messages: r.messages,
    liveShare: r.live_share, source: r.source as SpamChat['source'], createdAt: r.created_at,
  };
}

export function spamChatReason(db: Db, chatId: number): string | null {
  ensureDedupeSchema(db.raw);
  const r = db.raw.prepare('SELECT reason FROM spam_chats WHERE tg_chat_id = ?').get(chatId) as { reason: string } | undefined;
  return r?.reason ?? null;
}

export function createSpamChats(deps: { db: Db; engine: TelegramEngine; emit: (e: AppEvent) => void }) {
  const { db, engine, emit } = deps;
  ensureDedupeSchema(db.raw);

  async function block(chat: { chatId: number; title: string; username: string | null }, reason: string, h: ChatHealth, source: SpamChat['source']) {
    for (const acc of db.listAccounts().filter((a) => a.status === 'authorized')) {
      await engine.leaveChat(acc.id, chat.chatId).catch(() => {}); // not a member on this account
    }
    db.raw.prepare(
      `INSERT INTO spam_chats(tg_chat_id, title, username, reason, messages, live_share, source, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(tg_chat_id) DO UPDATE SET reason = excluded.reason, source = excluded.source`,
    ).run(chat.chatId, chat.title, chat.username, reason, h.messages, h.messages ? h.live / h.messages : 0, source, Date.now());
    for (const s of db.findSourcesByChat(chat.chatId)) {
      const updated = db.updateSource(s.id, { status: 'spam' });
      emit({ type: 'source:update', source: updated });
      emit({ type: 'job', projectId: s.projectId, stage: `Вышли из спам-чата «${chat.title}»: ${reason}`, done: true });
    }
    return toSpamChat(db.raw.prepare('SELECT * FROM spam_chats WHERE tg_chat_id = ?').get(chat.chatId) as SpamChatRow);
  }

  async function isOwnOrChannel(accountIds: number[], chatId: number): Promise<boolean> {
    for (const id of accountIds) {
      const chat = await engine.getChat(id, chatId).catch(() => null);
      if (chat?.kind === 'channel' || chat?.isAdmin) return true;
    }
    return false;
  }

  return {
    list(): SpamChat[] {
      return (db.raw.prepare('SELECT * FROM spam_chats ORDER BY created_at DESC').all() as SpamChatRow[]).map(toSpamChat);
    },

    // Every active source once, from its latest messages in Telegram; chats in several projects are judged once
    async check(now = Date.now()): Promise<SpamChat[]> {
      const authorized = db.listAccounts().filter((a) => a.status === 'authorized').map((a) => a.id);
      const blocked: SpamChat[] = [];
      const seen = new Set<number>();
      for (const s of db.listAllSources().filter((x) => x.status === 'active')) {
        if (seen.has(s.tgChatId) || spamChatReason(db, s.tgChatId)) continue;
        seen.add(s.tgChatId);
        const accountId = s.accountId != null && authorized.includes(s.accountId) ? s.accountId : authorized[0];
        if (accountId == null) return blocked;
        let history: TgMessage[];
        try {
          // a channel has one author by design, and our own chats are never left
          if (await isOwnOrChannel(authorized, s.tgChatId)) continue;
          history = await engine.getMessagesBefore(accountId, s.tgChatId, null, SAMPLE);
        } catch {
          continue; // not readable now; next round
        }
        const h = assessMessages(history);
        const reason = spamVerdict(h, now);
        if (reason) blocked.push(await block({ chatId: s.tgChatId, title: s.title, username: s.username }, reason, h, 'auto'));
      }
      return blocked;
    },

    async blockByOwner(accountId: number, chatId: number): Promise<SpamChat> {
      const chat = await engine.getChat(accountId, chatId);
      const history = await engine.getMessagesBefore(accountId, chatId, null, SAMPLE).catch(() => []);
      return block(chat, 'отмечен вручную', assessMessages(history), 'owner');
    },

    unblock(tgChatId: number) {
      db.raw.prepare('DELETE FROM spam_chats WHERE tg_chat_id = ?').run(tgChatId);
      for (const s of db.findSourcesByChat(tgChatId).filter((x) => x.status === 'spam')) {
        emit({ type: 'source:update', source: db.updateSource(s.id, { status: 'candidate' }) });
      }
    },
  };
}

// Joining a blocked chat fails everywhere (outreach, broadcasts, imports, the «Чаты» section) with the reason
export function guardSpamJoins(engine: TelegramEngine, db: Db): TelegramEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'joinChat') {
        return async (accountId: number, chatId: number) => {
          const reason = spamChatReason(db, chatId);
          if (reason) throw new Error(`Это спам-чат (${reason}) — вступать в него нельзя`);
          return target.joinChat(accountId, chatId);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

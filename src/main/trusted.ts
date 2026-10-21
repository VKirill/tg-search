// «Свои люди»: contacts whose tasks the agent takes for free — the owner trains the agent on their real requests.
// The agent answers them even when auto-replies to clients are off, never quotes prices or bills them, and can write
// to them once a day to ask for tasks.
import type { AppEvent, Lead, TrustedContact } from '../shared/types';
import type { Db } from './db';
import type { TelegramEngine } from './telegram/types';

export const CHECKIN_TICK_MS = 10 * 60_000;

type Row = Record<string, any>;

function ensureSchema(db: Db) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS trusted_contacts (
    username TEXT PRIMARY KEY,
    user_id INTEGER,
    free INTEGER NOT NULL DEFAULT 1,
    daily_checkin INTEGER NOT NULL DEFAULT 0,
    checkin_hour INTEGER NOT NULL DEFAULT 11,
    last_checkin_at INTEGER,
    note TEXT NOT NULL DEFAULT ''
  )`);
}

const norm = (u: string) => u.trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '').toLowerCase();

function toContact(r: Row): TrustedContact {
  return {
    username: r.username, userId: r.user_id, free: !!r.free, dailyCheckin: !!r.daily_checkin, checkinHour: r.checkin_hour,
    lastCheckinAt: r.last_checkin_at, note: r.note,
  };
}

export function listTrusted(db: Db): TrustedContact[] {
  ensureSchema(db);
  return (db.raw.prepare('SELECT * FROM trusted_contacts ORDER BY username').all() as Row[]).map(toContact);
}

export function trustedFor(db: Db, who: { username: string | null; userId: number | null }): TrustedContact | null {
  const name = who.username ? norm(who.username) : null;
  return listTrusted(db).find((c) => (name && c.username === name) || (who.userId != null && c.userId === who.userId)) ?? null;
}

export function isFreeLead(db: Db, lead: Lead): boolean {
  return !!trustedFor(db, { username: lead.authorUsername, userId: lead.authorUserId })?.free;
}

export function isTrustedLead(db: Db, lead: Lead): boolean {
  return trustedFor(db, { username: lead.authorUsername, userId: lead.authorUserId }) != null;
}

export function freeClientBlock(owner: string): string {
  return `<free_client>
Это свой человек ${owner || 'владельца'}: его задания выполняются бесплатно — так мы тренируем тебя на реальных задачах. Цен не называй, счёт и подписку не предлагай, ничего не допродавай. Принимай любое поручение и веди его как опытный исполнитель, без превью и без ожидания оплаты. Сначала сам уточни детали, без которых результат выйдет хуже, — одним сообщением со списком (для карточки товара: размеры, материалы, что выделить на слайдах, какие тексты и преимущества написать; о том, что видно на фото, не спрашивай). Как только ответ есть или уточнять нечего — услуга из каталога через create_or_update_order (фото и файлы из переписки прикрепятся сами) и сразу start_work; исследования, тексты, семантика, таблицы — assign_task нужному subagent. Всё это идёт в фоне, параллельно, результат придёт клиенту сам — а ты продолжаешь разговор. Если задача вне твоих возможностей — честно скажи и передай владельцу (handoff).
</free_client>`;
}

export function checkinNote(owner: string, firstTime: boolean): string {
  return `Система: сейчас ты пишешь первым — ежедневное касание. Это свой человек ${owner || 'владельца'}, он даёт тебе задания бесплатно. ` +
    (firstTime
      ? 'Вы ещё не общались: поздоровайся по-простому и в паре слов скажи, с чем можешь помочь (найти что-то, тексты, карточки товаров, картинки). '
      : '') +
    'Спроси, есть ли на сегодня задачи; если недавно было поручение — спроси, всё ли подошло. Одно-два коротких сообщения в манере из блока style, каждый день по-разному.';
}

export function createTrusted(deps: {
  db: Db;
  engine: TelegramEngine;
  emit: (e: AppEvent) => void;
  checkin: (leadId: number, note: string) => Promise<void>; // one proactive agent turn
}) {
  const { db, engine, emit } = deps;
  ensureSchema(db);

  // The private-chat lead of a contact; created on the first contact (an empty publication: it is a personal chat)
  async function leadFor(c: TrustedContact): Promise<Lead> {
    const accountId = db.listAccounts().find((a) => a.status === 'authorized')?.id;
    if (accountId == null) throw new Error('Подключите рабочий аккаунт Telegram');
    if (c.userId != null) {
      const existing = db.findLeadsByAuthor(c.userId)[0];
      if (existing) return existing;
    }
    const chat = await engine.resolveChat(accountId, `@${c.username}`);
    if (chat.kind !== 'private') throw new Error(`@${c.username} — не человек, а ${chat.kind}`);
    db.raw.prepare('UPDATE trusted_contacts SET user_id = ? WHERE username = ?').run(chat.chatId, c.username);
    const existing = db.findLeadsByAuthor(chat.chatId)[0];
    if (existing) return existing;
    return createLead(chat.chatId, c.username, chat.title, accountId);
  }

  function createLead(userId: number, username: string | null, name: string | null, accountId: number): Lead {
    const project = db.listProjects()[0];
    if (!project) throw new Error('Нет тематики для лида');
    const lead = db.addLead({
      projectId: project.id, sourceId: null, tgChatId: userId, tgMessageId: 0, authorUserId: userId, authorName: name,
      authorUsername: username, text: '', date: Date.now(), link: null, score: 100, label: 'demand',
      reason: 'Свой человек: задания бесплатно',
    })!;
    const updated = db.updateLead(lead.id, { status: 'dialog', accountId });
    emit({ type: 'lead:new', lead: updated });
    return updated;
  }

  return {
    list: () => listTrusted(db),

    save(c: Pick<TrustedContact, 'username'> & Partial<Omit<TrustedContact, 'username' | 'userId' | 'lastCheckinAt'>>): TrustedContact {
      const username = norm(c.username);
      if (!/^[a-z0-9_]{4,}$/.test(username)) throw new Error('Укажите @username');
      db.raw.prepare(
        `INSERT INTO trusted_contacts(username, free, daily_checkin, checkin_hour, note) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET free = excluded.free, daily_checkin = excluded.daily_checkin,
           checkin_hour = excluded.checkin_hour, note = excluded.note`,
      ).run(username, Number(c.free ?? true), Number(c.dailyCheckin ?? false), Math.min(23, Math.max(0, c.checkinHour ?? 11)), c.note ?? '');
      return toContact(db.raw.prepare('SELECT * FROM trusted_contacts WHERE username = ?').get(username) as Row);
    },

    remove(username: string) {
      db.raw.prepare('DELETE FROM trusted_contacts WHERE username = ?').run(norm(username));
    },

    // A private message from a contact without a lead yet: open their personal-chat lead
    leadForIncoming(msg: { senderUserId: number | null; senderUsername: string | null; senderName: string | null }, accountId: number): Lead | null {
      if (msg.senderUserId == null) return null;
      const c = trustedFor(db, { username: msg.senderUsername, userId: msg.senderUserId });
      if (!c) return null;
      db.raw.prepare('UPDATE trusted_contacts SET user_id = ? WHERE username = ?').run(msg.senderUserId, c.username);
      return createLead(msg.senderUserId, msg.senderUsername, msg.senderName, accountId);
    },

    // Once a day after checkinHour, unless we already talked today
    async checkinTick(now = new Date(), force = false) {
      for (const c of listTrusted(db).filter((x) => x.dailyCheckin)) {
        const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if ((!force && now.getHours() < c.checkinHour) || (c.lastCheckinAt ?? 0) >= dayStart) continue;
        try {
          const lead = await leadFor(c);
          const messages = db.listMessages(lead.id);
          const talkedToday = messages.some((m) => m.date >= dayStart);
          if (!talkedToday) await deps.checkin(lead.id, checkinNote(db.getSettings().ownerName, messages.length === 0));
          db.raw.prepare('UPDATE trusted_contacts SET last_checkin_at = ? WHERE username = ?').run(now.getTime(), c.username);
        } catch (err) {
          console.error('trusted checkin', c.username, err);
        }
      }
    },
  };
}

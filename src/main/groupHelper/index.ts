// The homework helper in a public group (t.me/gdz_chat_all): it listens to the chat, Jev decides whether a message
// asks to solve a task, a page with several tasks gets a question («какую? номер или «все»»), and the solution goes
// as a reply to the author's message. Requests live in the database, so a restart picks them up.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEvent, HelperChat, HelperRequest, Settings } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { afterSend, canSend } from '../pipeline/limiter';
import { trustedFor } from '../trusted';

export const TASK_THRESHOLD = 0.5;
const ASK_TTL_MS = 3 * 3600_000; // a «какую решить?» question waits this long for the answer
const MAX_PARALLEL = 3;
const POLL_TASKS_MAX = 9; // poll options: the tasks plus «Все»
const ALL = 'Все';
const POLL_CHECK_MS = 4000;
const CATCH_UP_MS = 6 * 3600_000; // messages missed while the app was off: no older than this

export interface GroupHelperDeps {
  db: Db;
  engine: TelegramEngine;
  dataDir: string;
  emit: (e: AppEvent) => void;
  getSettings: () => Settings;
  setSettings: (patch: Partial<Settings>) => void;
  isTaskRequest: (message: string, picture: string) => Promise<number>; // Jev: probability the author wants a task solved
  describePhoto: (path: string) => Promise<{ caption: string; tasks: string[] }>; // vision: what is on it, task labels
  solve: (job: { key: string; task: string; photos: string[]; dir: string }) => Promise<string>; // solver → Markdown
}

// «все», «реши всё», «3», «№ 2 и 5», «задачи 1, 4», «упр. 12б»
export function parseSelection(text: string): 'all' | string[] | null {
  const t = text.toLowerCase().replace(/ё/g, 'е');
  if (/(^|[^а-я])(все|всю страницу|целиком|полностью)([^а-я]|$)/.test(t)) return 'all';
  const marked = [...t.matchAll(/(?:№|номер|задач[аеиуы]?|упр(?:ажнени[ея])?\.?|пример)\s*((?:\d+[а-я]?(?:\s*(?:,|и|-)\s*)?)+)/g)]
    .flatMap((m) => m[1].split(/\s*(?:,|и)\s*/));
  const bare = t.trim().length <= 24 && /^[\d\s,и№.а-я-]*$/.test(t.trim()) ? t.match(/\d+[а-я]?/g) ?? [] : [];
  const nums = [...new Set([...marked, ...bare].map((s) => s.trim()).filter((s) => /^\d+[а-я]?$/.test(s)))];
  return nums.length ? nums : null;
}

type Row = Record<string, any>;
const toRequest = (r: Row): HelperRequest => ({
  id: r.id, chatId: r.chat_id, messageId: r.message_id, accountId: r.account_id, userId: r.user_id, userName: r.user_name,
  text: r.text, photos: JSON.parse(r.photos), tasks: JSON.parse(r.tasks), selection: r.selection, status: r.status,
  error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function createGroupHelper(deps: GroupHelperDeps) {
  const { db } = deps;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS helper_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL, message_id INTEGER NOT NULL, account_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL, user_name TEXT,
    text TEXT NOT NULL DEFAULT '',
    photos TEXT NOT NULL DEFAULT '[]', -- local copies of the photos
    tasks TEXT NOT NULL DEFAULT '[]', -- task labels seen on the photo
    picture TEXT NOT NULL DEFAULT '', -- what the vision model saw
    selection TEXT, -- 'all' or «1, 4»
    status TEXT NOT NULL, -- ignored | asked | queued | solving | done | failed | limit
    question_id INTEGER, -- our «какую решить?» message
    error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(chat_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS helper_seen (chat_id INTEGER PRIMARY KEY, message_id INTEGER NOT NULL)`);
  try {
    db.raw.exec("ALTER TABLE helper_requests ADD COLUMN options TEXT"); // the poll's answer options, when we asked with a poll
  } catch {
    /* already there */
  }
  try {
    db.raw.exec('ALTER TABLE helper_requests ADD COLUMN ack_id INTEGER'); // «🔥 взял задачу» — removed when the answer comes
  } catch {
    /* already there */
  }

  const chats = (): HelperChat[] => {
    try {
      return JSON.parse(deps.getSettings().helperChats || '[]');
    } catch {
      return [];
    }
  };
  const set = (id: number, patch: Record<string, unknown>) => {
    for (const [k, v] of Object.entries({ ...patch, updated_at: Date.now() })) db.raw.prepare(`UPDATE helper_requests SET ${k} = ? WHERE id = ?`).run(v as never, id);
  };
  const get = (id: number) => db.raw.prepare('SELECT * FROM helper_requests WHERE id = ?').get(id) as Row;

  // Every outgoing message goes through the account's limiter: answers to people who asked skip the daily cap, and the
  // pause is the helper's own (seconds — a chat answer should not wait the 3 minutes cold outreach does); one send at a
  // time per account, and the send counts for the account's pause like any other
  const sendChains = new Map<number, Promise<unknown>>();
  function sendLimited<T>(accountId: number, send: () => Promise<T>): Promise<T> {
    const run = async () => {
      for (;;) {
        const account = db.getAccount(accountId);
        const pauseSec = Math.max(0, Number(deps.getSettings().helperPauseSec ?? 5) || 0);
        const gate = canSend({ ...account, pauseSec: Math.min(account.pauseSec, pauseSec) }, Date.now(), true);
        if (gate.ok) break;
        await new Promise((r) => setTimeout(r, (gate.reason === 'pause' ? gate.waitMs ?? 1000 : 60_000) + 300));
      }
      const out = await send();
      db.updateAccount(accountId, afterSend(db.getAccount(accountId), Date.now(), true));
      return out;
    };
    const next = (sendChains.get(accountId) ?? Promise.resolve()).then(run, run);
    sendChains.set(accountId, next.catch(() => {}));
    return next;
  }

  let running = 0;
  const waiting: number[] = [];
  const asGroup = (chatId: number) => chats().find((c) => c.chatId === chatId)?.asGroup !== false;

  function enqueue(id: number) {
    set(id, { status: 'queued' });
    // on behalf of the group there are no reactions (Telegram forbids them to anonymous admins): a short «taken» note
    // instead, deleted when the solution comes
    const r = get(id);
    if (asGroup(r.chat_id) && !r.ack_id) {
      void sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id, '🔥 взял задачу, решаю — минутку'))
        .then((m) => set(id, { ack_id: m.messageId }))
        .catch((err) => console.warn('group helper ack', err instanceof Error ? err.message : err));
    }
    waiting.push(id);
    pump();
  }
  function pump() {
    while (running < MAX_PARALLEL && waiting.length) {
      const id = waiting.shift()!;
      running++;
      void solveRequest(id).finally(() => {
        running--;
        pump();
      });
    }
  }

  async function solveRequest(id: number) {
    const r = get(id);
    if (!r || r.status === 'done') return;
    set(id, { status: 'solving' });
    const which = r.selection === 'all' || !r.selection ? 'все задачи с фото' : `задачи ${r.selection}`;
    const task = [
      r.text.trim() ? `Сообщение ученика: ${r.text.trim()}` : '',
      JSON.parse(r.photos).length ? `На фото: ${r.picture}. Решить: ${which}.` : '',
      'Ответ увидят все участники чата ГДЗ: реши в обучающем формате, чтобы было понятно, как решать такие задачи.',
      'Уровень — класс из описания фото или сообщения: методы его школьной программы, один основной способ, без лишнего.',
    ].filter(Boolean).join('\n');
    try {
      const dir = join(deps.dataDir, 'group', String(r.chat_id), String(r.message_id));
      const text = await deps.solve({ key: `group:${r.chat_id}:${r.message_id}`, task, photos: JSON.parse(r.photos), dir });
      if (!text.trim()) throw new Error('пустое решение');
      await sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id, text));
      set(id, { status: 'done', error: null });
      await dropAck(id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`group helper: request ${id} failed`, error);
      set(id, { status: 'failed', error });
      await sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id,
        'не получилось разобрать задание 😕 пришли, пожалуйста, фото почётче или перепиши условие текстом')).catch(() => {});
      await dropAck(id);
    }
  }

  async function dropAck(id: number) {
    const r = get(id);
    if (!r.ack_id) return;
    await deps.engine.deleteMessages(r.account_id, r.chat_id, [r.ack_id]).catch((err) => console.warn('group helper ack delete', err instanceof Error ? err.message : err));
    set(id, { ack_id: null });
  }

  function solvedToday(chatId: number, userId: number): number {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    return (db.raw.prepare(`SELECT COUNT(*) AS n FROM helper_requests WHERE chat_id = ? AND user_id = ? AND created_at >= ?
      AND status IN ('queued', 'solving', 'done')`).get(chatId, userId, day.getTime()) as { n: number }).n;
  }

  async function onMessage(accountId: number, msg: TgMessage) {
    const chat = chats().find((c) => c.enabled && c.chatId === msg.chatId && c.accountId === accountId);
    if (!chat) return;
    // the last message read: after a restart the helper reads on from here
    db.raw.prepare(`INSERT INTO helper_seen(chat_id, message_id) VALUES(?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET message_id = MAX(message_id, excluded.message_id)`).run(msg.chatId, msg.messageId);
    if (msg.isOutgoing || msg.senderIsBot || msg.senderUserId == null) return;
    if (db.raw.prepare('SELECT 1 FROM helper_requests WHERE chat_id = ? AND message_id = ?').get(msg.chatId, msg.messageId)) return;
    const userId = msg.senderUserId;
    const now = Date.now();

    // the answer to our «какую решить?»: a reply to it, or the author's next short message without a new photo
    const asked = db.raw.prepare(`SELECT * FROM helper_requests WHERE chat_id = ? AND user_id = ? AND status = 'asked' AND created_at > ?
      ORDER BY id DESC LIMIT 1`).get(msg.chatId, userId, now - ASK_TTL_MS) as Row | undefined;
    if (asked && !msg.photo && (msg.replyToMessageId === asked.question_id || msg.replyToMessageId === asked.message_id || msg.text.length <= 40)) {
      const sel = parseSelection(msg.text);
      if (sel) {
        set(asked.id, { selection: sel === 'all' ? 'all' : sel.join(', ') });
        enqueue(asked.id);
        return;
      }
    }

    if (!msg.photo && msg.text.trim().length < 8) return; // «спасибо», «ок»
    let photos: string[] = [];
    let picture = '';
    let tasks: string[] = [];
    if (msg.photo) {
      const downloaded = await deps.engine.downloadFile(accountId, msg.photo.fileId);
      const dir = join(deps.dataDir, 'group', String(msg.chatId), String(msg.messageId));
      mkdirSync(dir, { recursive: true });
      const path = join(dir, 'task.jpg');
      copyFileSync(downloaded, path);
      photos = [path];
      ({ caption: picture, tasks } = await deps.describePhoto(path).catch(() => ({ caption: '', tasks: [] as string[] })));
    }
    // Jev decides whether this is a request at all — the solving agent is not woken for chatter
    const p = await deps.isTaskRequest(msg.text, picture).catch(() => 0);
    const insert = (status: HelperRequest['status'], selection: string | null = null) => Number(db.raw.prepare(`INSERT INTO helper_requests
      (chat_id, message_id, account_id, user_id, user_name, text, photos, tasks, picture, selection, status, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.chatId, msg.messageId, accountId, userId, msg.senderName ?? msg.senderUsername ?? '',
      msg.text, JSON.stringify(photos), JSON.stringify(tasks), picture, selection, status, now, now).lastInsertRowid);
    if (p < TASK_THRESHOLD) {
      insert('ignored');
      return;
    }
    // 🔥 right away: the author sees the task is noticed while the photo is read and the question or solution comes
    if (!asGroup(msg.chatId)) void deps.engine.react(accountId, msg.chatId, msg.messageId, '🔥').catch((err) => console.warn('group helper reaction', err instanceof Error ? err.message : err));
    const cap = Number(deps.getSettings().helperDailyPerUser || 0);
    const own = trustedFor(db, { username: msg.senderUsername, userId }) != null; // «свои люди» have no daily cap
    if (cap > 0 && !own && solvedToday(msg.chatId, userId) >= cap) {
      const already = db.raw.prepare(`SELECT 1 FROM helper_requests WHERE chat_id = ? AND user_id = ? AND status = 'limit' AND created_at > ?`)
        .get(msg.chatId, userId, now - 12 * 3600_000);
      const id = insert('limit');
      if (!already) {
        await sendLimited(accountId, () => deps.engine.replyInChat(accountId, msg.chatId, msg.messageId,
          `на сегодня бесплатные решения закончились (${cap} в день) — завтра продолжим. если срочно, напиши мне в личку 🙂`)).catch((err) => set(id, { error: String(err) }));
      }
      return;
    }
    const sel = parseSelection(msg.text);
    if (photos.length && tasks.length > 1 && !sel) {
      // a poll for the author: only their vote counts; a text answer from them works too
      const id = insert('asked');
      const options = tasks.length <= POLL_TASKS_MAX ? [...tasks.map((t) => (/^№/.test(t) ? t : `№ ${t}`)), ALL] : null;
      const who = (msg.senderName ?? '').split(' ')[0];
      const question = `${who ? `${who}, к` : 'К'}акие задания решить? Можно выбрать несколько`.slice(0, 255);
      let poll = false;
      const q = await (options
        ? sendLimited(accountId, () => deps.engine.sendPoll(accountId, msg.chatId, msg.messageId, question, options)).then((m) => ((poll = true), m))
        : Promise.reject(new Error('слишком много заданий для опроса')))
        .catch(() => sendLimited(accountId, () => deps.engine.replyInChat(accountId, msg.chatId, msg.messageId,
          `вижу на фото задания ${tasks.slice(0, 20).join(', ')} — какое решить? напиши номер в ответ или «все»`)));
      set(id, { question_id: q.messageId, options: poll ? JSON.stringify(options) : null });
      return;
    }
    const id = insert('queued', sel === 'all' || !sel ? 'all' : sel.join(', '));
    enqueue(id);
  }

  // The author's vote in our poll: as soon as they choose, the poll closes and the solving starts
  async function checkPolls() {
    const rows = db.raw.prepare("SELECT * FROM helper_requests WHERE status = 'asked' AND options IS NOT NULL").all() as Row[];
    for (const r of rows) {
      if (r.created_at < Date.now() - ASK_TTL_MS) {
        set(r.id, { status: 'ignored', error: 'не выбрал задания' });
        await deps.engine.stopPoll(r.account_id, r.chat_id, r.question_id).catch(() => {});
        continue;
      }
      const options: string[] = JSON.parse(r.options);
      const chosen: string[] = [];
      for (const [i, option] of options.entries()) {
        const voters = await deps.engine.pollVoters(r.account_id, r.chat_id, r.question_id, i).catch(() => [] as number[]);
        if (voters.includes(r.user_id)) chosen.push(option);
      }
      if (!chosen.length) continue;
      set(r.id, { selection: chosen.includes(ALL) ? 'all' : chosen.join(', ') });
      await deps.engine.stopPoll(r.account_id, r.chat_id, r.question_id).catch(() => {});
      enqueue(r.id);
    }
  }
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  return {
    stop() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    },
    async start() {
      // answers go on behalf of the group unless the owner turned it off for a chat
      for (const chat of chats().filter((c) => c.enabled)) {
        const asGroup = chat.asGroup !== false;
        const ok = await deps.engine.sendAsGroup(chat.accountId, chat.chatId, asGroup).catch((err) => {
          console.warn('group helper send-as', chat.title, err instanceof Error ? err.message : err);
          return false;
        });
        if (asGroup && !ok) console.warn(`group helper: «${chat.title}» does not offer sending on behalf of the group to this account`);
      }
      pollTimer = setInterval(() => void checkPolls().catch((err) => console.error('group helper polls', err)), POLL_CHECK_MS);
      deps.engine.onChatMessage((accountId, msg) => {
        onMessage(accountId, msg).catch((err) => console.error('group helper', msg.chatId, msg.messageId, err));
      });
      // interrupted by a restart: solve again
      for (const r of db.raw.prepare("SELECT id FROM helper_requests WHERE status IN ('queued', 'solving')").all() as { id: number }[]) enqueue(r.id);
      // what came while the app was off or restarting (a task, the «все» to our question): read on, oldest first
      for (const chat of chats().filter((c) => c.enabled)) {
        const seen = db.raw.prepare('SELECT message_id FROM helper_seen WHERE chat_id = ?').get(chat.chatId) as { message_id: number } | undefined;
        try {
          const missed = await deps.engine.getHistory(chat.accountId, chat.chatId, Date.now() - CATCH_UP_MS, seen?.message_id ?? null, 100);
          for (const m of missed) await onMessage(chat.accountId, m).catch((err) => console.error('group helper catch-up', m.messageId, err));
          if (missed.length) console.log(`group helper: read ${missed.length} missed message(s) in ${chat.title}`);
        } catch (err) {
          console.error('group helper catch-up', chat.chatId, err);
        }
      }
    },
    chats,
    saveChats(list: HelperChat[]) {
      deps.setSettings({ helperChats: JSON.stringify(list) });
      for (const c of list.filter((x) => x.enabled)) void deps.engine.sendAsGroup(c.accountId, c.chatId, c.asGroup !== false).catch(() => {});
      return chats();
    },
    requests(limit = 50): HelperRequest[] {
      return (db.raw.prepare('SELECT * FROM helper_requests ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toRequest);
    },
    onMessage, // for tests
    checkPolls, // for tests
  };
}

export type GroupHelper = ReturnType<typeof createGroupHelper>;


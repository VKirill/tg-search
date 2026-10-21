// The group assistant: in the groups the owner connects, it listens to members and answers by the group's scenario —
// «tasks» (solves tasks sent as text or photo; a page with several gets a poll for its author) or «questions» (answers
// questions on the group's topic). Jev decides whether a message is a request at all, so the agent is not woken for
// chatter; the answer goes as a reply to the author. Requests live in the database, so a restart picks them up.
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUILTIN_HELPER_SCENARIOS, HELPER_DEFAULT_TEXTS, HELPER_KINDS,
  type AppEvent, type HelperBehavior, type HelperChat, type HelperKind, type HelperRequest, type HelperScenarioDef, type HelperSetup, type Settings,
} from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { afterSend, canSend } from '../pipeline/limiter';
import { trustedFor } from '../trusted';

export const TASK_THRESHOLD = 0.5;
export const kindOf = (s: HelperSetup): HelperKind => s.kind;
export const helperAgent = (s: HelperSetup): string => s.agent?.trim() || HELPER_KINDS[s.kind].agent;

const BEHAVIOR_KEYS: (keyof HelperBehavior)[] = [
  'jevCheck', 'jevPrompt', 'threshold', 'repliesOnly', 'keywords', 'askWhich', 'mode', 'agent', 'helpers', 'model', 'verify',
  'verifier', 'knowledge', 'knowledgeOnly', 'skills', 'texts',
];

// The built-in scenarios with the owner's changes, then the owner's own
export function listScenarios(stored: HelperScenarioDef[]): HelperScenarioDef[] {
  const byId = new Map(stored.map((s) => [s.id, s]));
  const builtIn = BUILTIN_HELPER_SCENARIOS.map((b) => ({ ...b, ...byId.get(b.id), id: b.id, builtIn: true }));
  return [...builtIn, ...stored.filter((s) => !BUILTIN_HELPER_SCENARIOS.some((b) => b.id === s.id)).map((s) => ({ ...s, builtIn: false }))];
}

// A group with its scenario: the scenario's behavior, the group's place and topic
export function setupOf(chat: HelperChat, scenarios: HelperScenarioDef[], override?: HelperScenarioDef): HelperSetup {
  const sc = override ?? scenarios.find((s) => s.id === (chat.scenario ?? 'tasks')) ?? scenarios[0] ?? BUILTIN_HELPER_SCENARIOS[0];
  const behavior = Object.fromEntries(BEHAVIOR_KEYS.filter((k) => sc[k] !== undefined).map((k) => [k, sc[k]])) as HelperBehavior;
  return {
    chatId: chat.chatId, title: chat.title, username: chat.username, accountId: chat.accountId, enabled: chat.enabled, channel: chat.channel,
    scenario: sc.id, about: chat.about, instructions: chat.instructions, dailyCap: chat.dailyCap, asGroup: chat.asGroup,
    ...behavior, kind: sc.kind, scenarioName: sc.name,
  };
}

// What the helper says: the group's own phrase or the scenario's
export function helperText(chat: HelperSetup, key: 'ack' | 'fail' | 'limit', cap = 0): string {
  const own = chat.texts?.[key]?.trim();
  return (own || HELPER_DEFAULT_TEXTS[chat.kind][key]).replaceAll('{cap}', String(cap));
}

// Filters before Jev: keywords and «only replies to the helper / mentions of the account»; null — passes
export function filterReason(chat: HelperSetup, text: string, opts: { replyToOurs: boolean; mention: boolean }): string | null {
  const words = (chat.keywords ?? []).map((w) => w.trim().toLowerCase()).filter(Boolean);
  if (words.length && !words.some((w) => text.toLowerCase().includes(w))) return 'нет ключевых слов';
  if (chat.repliesOnly && !opts.replyToOurs && !opts.mention) return 'не ответ помощнику и не упоминание';
  return null;
}

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
  isRequest: (chat: HelperSetup, message: string, picture: string) => Promise<number>; // Jev: probability it is a request for this group
  describePhoto: (path: string) => Promise<{ caption: string; tasks: string[] }>; // vision: what is on it, task labels
  answer: (chat: HelperSetup, job: { key: string; task: string; query: string; photos: string[]; dir: string }) => Promise<string>; // the agent → Markdown; `query` — the member's own words, for knowledge search
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
  error: r.error, createdAt: r.created_at, updatedAt: r.updated_at, score: r.score ?? null, answer: r.answer ?? null, agent: r.agent ?? null,
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
  for (const col of [
    'ack_id INTEGER', // «🔥 взял задачу» — removed when the answer comes
    'answer_id INTEGER', // our answer: replies to it count as replies to the helper
    'score REAL', // Jev's probability that it needs an answer
    'answer TEXT', // what was answered
    'agent TEXT',
  ]) {
    try {
      db.raw.exec(`ALTER TABLE helper_requests ADD COLUMN ${col}`);
    } catch {
      /* already there */
    }
  }

  const chats = (): HelperChat[] => {
    try {
      return JSON.parse(deps.getSettings().helperChats || '[]');
    } catch {
      return [];
    }
  };
  const storedScenarios = (): HelperScenarioDef[] => {
    try {
      return JSON.parse(deps.getSettings().helperScenarios || '[]');
    } catch {
      return [];
    }
  };
  const scenarios = () => listScenarios(storedScenarios());
  const setups = (): HelperSetup[] => {
    const list = scenarios();
    return chats().map((c) => setupOf(c, list));
  };

  // Groups set up before scenarios kept their behavior on the group: it becomes the group's own scenario
  (function migrate() {
    const list = chats();
    const own = storedScenarios();
    let changed = false;
    const next = list.map((c) => {
      const legacy = c as HelperChat & HelperBehavior & { scenario?: string };
      const behavior = Object.fromEntries(BEHAVIOR_KEYS.filter((k) => legacy[k] !== undefined).map((k) => [k, legacy[k]])) as HelperBehavior;
      const base: HelperChat = {
        chatId: c.chatId, title: c.title, username: c.username, accountId: c.accountId, enabled: c.enabled, channel: c.channel,
        about: c.about, instructions: c.instructions, dailyCap: c.dailyCap, asGroup: c.asGroup,
        scenario: c.scenario === 'custom' ? 'questions' : c.scenario,
      };
      if (!Object.keys(behavior).length && c.scenario !== 'custom') return c;
      changed = true;
      if (!Object.keys(behavior).length) return base;
      const id = `group-${c.chatId}`;
      const kind: HelperKind = c.scenario === 'tasks' || !c.scenario ? 'tasks' : 'questions';
      own.push({ id, name: `Сценарий группы «${c.title}»`, description: 'Перенесён из настроек группы.', kind, ...behavior });
      return { ...base, scenario: id };
    });
    if (changed) deps.setSettings({ helperChats: JSON.stringify(next), helperScenarios: JSON.stringify(own) });
  })();
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
  const chatOf = (chatId: number) => setups().find((c) => c.chatId === chatId);
  const asGroup = (chatId: number) => chatOf(chatId)?.asGroup !== false;

  function enqueue(id: number) {
    set(id, { status: 'queued' });
    // on behalf of the group there are no reactions (Telegram forbids them to anonymous admins): a short «taken» note
    // instead, deleted when the solution comes
    const r = get(id);
    if (asGroup(r.chat_id) && !r.ack_id) {
      void sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id, helperText(chatOf(r.chat_id) ?? setupOf({} as HelperChat, scenarios()), 'ack')))
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
    const chat = chatOf(r.chat_id);
    if (!chat) return;
    set(id, { status: 'solving', agent: helperAgent(chat) });
    try {
      const dir = join(deps.dataDir, 'group', String(r.chat_id), String(r.message_id));
      const text = await deps.answer(chat, { key: `group:${r.chat_id}:${r.message_id}`, task: taskText(chat, r), query: [r.text, r.picture].filter(Boolean).join('\n'), photos: JSON.parse(r.photos), dir });
      if (!text.trim()) throw new Error('пустое решение');
      const sent = await sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id, text));
      set(id, { status: 'done', error: null, answer: text, answer_id: sent.messageId });
      await dropAck(id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`group helper: request ${id} failed`, error);
      set(id, { status: 'failed', error });
      await sendLimited(r.account_id, () => deps.engine.replyInChat(r.account_id, r.chat_id, r.message_id, helperText(chat, 'fail'))).catch(() => {});
      await dropAck(id);
    }
  }

  // The job for the agent: the member's message, the photo, the group's topic and rules
  function taskText(chat: HelperSetup, r: Row): string {
    const photo = JSON.parse(r.photos).length ? r.picture : '';
    const group = [chat.about?.trim() ? `О группе: ${chat.about.trim()}` : '', chat.instructions?.trim() ? `Как отвечать: ${chat.instructions.trim()}` : ''];
    if (chat.kind === 'questions') {
      return [
        `Вопрос участника группы: ${r.text.trim() || '(без текста)'}`, photo ? `К сообщению приложено фото: ${photo}.` : '', ...group,
        'Ответ увидят все участники группы: коротко и по делу.',
      ].filter(Boolean).join('\n');
    }
    const which = r.selection === 'all' || !r.selection ? 'все задачи с фото' : `задачи ${r.selection}`;
    return [
      r.text.trim() ? `Сообщение участника: ${r.text.trim()}` : '', photo ? `На фото: ${photo}. Решить: ${which}.` : '', ...group,
      'Ответ увидят все участники группы: реши в обучающем формате, чтобы было понятно, как решать такие задачи.',
      'Уровень — класс из описания фото или сообщения: методы его школьной программы, один основной способ, без лишнего.',
    ].filter(Boolean).join('\n');
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
    const chat = setups().find((c) => c.enabled && c.chatId === msg.chatId && c.accountId === accountId);
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
    // the group's filters come before Jev: no model is asked about what the owner excluded
    const ours = msg.replyToMessageId != null && !!db.raw.prepare(`SELECT 1 FROM helper_requests WHERE chat_id = ?
      AND ? IN (answer_id, question_id, ack_id)`).get(msg.chatId, msg.replyToMessageId);
    const me = db.getAccount(accountId).username;
    if (filterReason(chat, msg.text, { replyToOurs: ours, mention: !!me && msg.text.toLowerCase().includes(`@${me.toLowerCase()}`) })) return;
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
    // Jev decides whether this is a request at all — the agent is not woken for chatter
    const p = chat.jevCheck === false ? 1 : await deps.isRequest(chat, msg.text, picture).catch(() => 0);
    const insert = (status: HelperRequest['status'], selection: string | null = null) => Number(db.raw.prepare(`INSERT INTO helper_requests
      (chat_id, message_id, account_id, user_id, user_name, text, photos, tasks, picture, selection, status, score, created_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msg.chatId, msg.messageId, accountId, userId, msg.senderName ?? msg.senderUsername ?? '',
      msg.text, JSON.stringify(photos), JSON.stringify(tasks), picture, selection, status, p, now, now).lastInsertRowid);
    if (p < (chat.threshold ?? TASK_THRESHOLD)) {
      insert('ignored');
      return;
    }
    // 🔥 right away: the author sees the task is noticed while the photo is read and the question or solution comes
    if (!asGroup(msg.chatId)) void deps.engine.react(accountId, msg.chatId, msg.messageId, '🔥').catch((err) => console.warn('group helper reaction', err instanceof Error ? err.message : err));
    const cap = chat.dailyCap ?? Number(deps.getSettings().helperDailyPerUser || 0);
    const own = trustedFor(db, { username: msg.senderUsername, userId }) != null; // «свои люди» have no daily cap
    if (cap > 0 && !own && solvedToday(msg.chatId, userId) >= cap) {
      const already = db.raw.prepare(`SELECT 1 FROM helper_requests WHERE chat_id = ? AND user_id = ? AND status = 'limit' AND created_at > ?`)
        .get(msg.chatId, userId, now - 12 * 3600_000);
      const id = insert('limit');
      if (!already) {
        await sendLimited(accountId, () => deps.engine.replyInChat(accountId, msg.chatId, msg.messageId, helperText(chat, 'limit', cap)))
          .catch((err) => set(id, { error: String(err) }));
      }
      return;
    }
    const sel = chat.kind === 'tasks' ? parseSelection(msg.text) : null;
    if (chat.kind === 'tasks' && chat.askWhich !== false && photos.length && tasks.length > 1 && !sel) {
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
        // an anonymous admin posts as the group anyway; otherwise the account needs that admin right
        if (asGroup && !ok) console.warn(`group helper: «${chat.title}» — «send as group» is not offered; answers go as the group only if the account is an anonymous admin there`);
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
    scenarios,
    saveScenario(def: HelperScenarioDef): HelperScenarioDef[] {
      if (!def.name.trim()) throw new Error('Нужно название сценария');
      const id = def.id || `sc-${Date.now()}`;
      const rest = storedScenarios().filter((s) => s.id !== id);
      deps.setSettings({ helperScenarios: JSON.stringify([...rest, { ...def, id, builtIn: undefined }]) });
      return scenarios();
    },
    // own — deleted (its groups fall back to «Решение задач»); built-in — back to the shipped settings
    removeScenario(id: string): HelperScenarioDef[] {
      deps.setSettings({ helperScenarios: JSON.stringify(storedScenarios().filter((s) => s.id !== id)) });
      if (!BUILTIN_HELPER_SCENARIOS.some((b) => b.id === id)) {
        deps.setSettings({ helperChats: JSON.stringify(chats().map((c) => (c.scenario === id ? { ...c, scenario: 'tasks' } : c))) });
      }
      return scenarios();
    },
    saveChats(list: HelperChat[]) {
      deps.setSettings({ helperChats: JSON.stringify(list) });
      for (const c of list.filter((x) => x.enabled)) void deps.engine.sendAsGroup(c.accountId, c.chatId, c.asGroup !== false).catch(() => {});
      return chats();
    },
    requests(limit = 50, chatId?: number): HelperRequest[] {
      const rows = chatId == null
        ? db.raw.prepare('SELECT * FROM helper_requests ORDER BY id DESC LIMIT ?').all(limit)
        : db.raw.prepare('SELECT * FROM helper_requests WHERE chat_id = ? ORDER BY id DESC LIMIT ?').all(chatId, limit);
      return (rows as Row[]).map(toRequest);
    },
    // The sandbox: what the group's pipeline (knowledge, agents or a model, checking) would answer — sent nowhere
    async preview(group: HelperChat, text: string, scenario?: HelperScenarioDef): Promise<{ answer: string; ms: number }> {
      const chat = setupOf(group, scenarios(), scenario);
      const started = Date.now();
      const dir = join(deps.dataDir, 'group', 'preview', String(started));
      const answer = await deps.answer(chat, {
        key: `preview:${started}`, photos: [], dir, query: text,
        task: taskText(chat, { text, photos: '[]', picture: '', selection: null }),
      });
      return { answer, ms: Date.now() - started };
    },
    // The sandbox: what the group's filters and Jev say about a message, without answering it
    async test(group: HelperChat, text: string, scenario?: HelperScenarioDef): Promise<{ score: number; answer: boolean; reason: string }> {
      const chat = setupOf(group, scenarios(), scenario);
      const filtered = filterReason(chat, text, { replyToOurs: false, mention: false });
      if (filtered && !chat.repliesOnly) return { score: 0, answer: false, reason: filtered };
      const score = chat.jevCheck === false ? 1 : await deps.isRequest(chat, text, '');
      const threshold = chat.threshold ?? TASK_THRESHOLD;
      return {
        score, answer: score >= threshold,
        reason: chat.jevCheck === false ? 'проверка Jev выключена' : `Jev: ${Math.round(score * 100)}% при пороге ${Math.round(threshold * 100)}%` +
          (chat.repliesOnly ? ' (в группе отвечает только на ответы помощнику и упоминания)' : ''),
      };
    },
    onMessage, // for tests
    checkPolls, // for tests
  };
}

export type GroupHelper = ReturnType<typeof createGroupHelper>;


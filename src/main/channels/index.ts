// The channel assistant: a news desk for the owner's Telegram channel. Sources are collected non-stop, each on its own
// interval; new items are de-duplicated (by link and by headline) and scored by Jev — does it fit the channel, is it
// news, a deal or an event; at each slot's time the editor writes a post from the best fresh items in the channel's
// language, with links and a picture, and it is published (or waits for approval as a draft).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  AppEvent, ChannelDesk, ChannelItem, ChannelItemKind, ChannelPost, ChannelSlotKind, ChannelSource, Settings,
} from '../../shared/types';
import { CHANNEL_SLOT_KINDS, CHANNEL_SOURCE_KINDS } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine } from '../telegram/types';
import { afterSend, canSend } from '../pipeline/limiter';
import { htmlText } from '../knowledge';
import { parseJsonFromLlm } from '../ai/llm';
import { assertPublicHttpUrl } from '../agent/web';
import { parseFeed } from './feeds';

export const TICK_MS = 60_000;
const FRESH_MS = 36 * 3600_000; // what a post may still use
const FIRST_READ_MS = 2 * 86400_000; // a new source: the last two days, not its archive
const LATE_SLOT_MS = 3600_000; // a slot missed while the app was off: still posted within an hour, never later
const MIN_TELEGRAM_TEXT = 60;
const SCORE_BATCH = 8;
const POST_ITEMS: Record<ChannelSlotKind, number> = { digest: 6, deals: 6, top: 1 };

export interface Found {
  title: string;
  text: string;
  url: string | null;
  image: string | null;
  publishedAt: number;
}

export interface ChannelsDeps {
  db: Db;
  engine: TelegramEngine;
  dataDir: string;
  emit: (e: AppEvent) => void;
  getSettings: () => Settings;
  llm: (prompt: string, opts: { json?: boolean; role: 'chat' | 'fast' | 'smart'; title: string }) => Promise<string>;
  // Jev: for each item — how well it fits the channel (0–1) and what it is
  score: (about: string, items: { title: string; text: string }[]) => Promise<{ p: number; kind: ChannelItemKind | 'other' }[]>;
  search?: (query: string) => Promise<{ title: string; url: string; content: string }[]>;
  browse?: (url: string) => Promise<string>; // the page's text in the app's browser with the owner's login
  fetchFn?: typeof fetch;
  now?: () => number;
}

type Row = Record<string, any>;

const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 90);
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const toDesk = (r: Row): ChannelDesk => ({
  id: r.id, chatId: r.chat_id, title: r.title, username: r.username, accountId: r.account_id, enabled: !!r.enabled,
  language: r.language, about: r.about, editorPrompt: r.editor_prompt, slots: JSON.parse(r.slots), autopublish: !!r.autopublish,
  threshold: r.threshold, createdAt: r.created_at,
});
const toSource = (r: Row): ChannelSource => ({
  id: r.id, deskId: r.desk_id, kind: r.kind, title: r.title, target: r.target, enabled: !!r.enabled, intervalMin: r.interval_min,
  lastRunAt: r.last_run_at, lastError: r.last_error, found: r.found, createdAt: r.created_at,
});
const toItem = (r: Row): ChannelItem => ({
  id: r.id, deskId: r.desk_id, sourceId: r.source_id, sourceTitle: r.source_title ?? '', kind: r.kind, title: r.title, text: r.text,
  url: r.url, image: r.image, publishedAt: r.published_at, score: r.score, status: r.status, createdAt: r.created_at,
});
const toPost = (r: Row): ChannelPost => ({
  id: r.id, deskId: r.desk_id, kind: r.kind, text: r.text, image: r.image, itemIds: JSON.parse(r.item_ids), status: r.status,
  error: r.error, messageId: r.message_id, publishedAt: r.published_at, createdAt: r.created_at,
});

export const DEFAULT_EDITOR = [
  'Пиши как живой городской редактор: коротко, по делу, с характером, без канцелярита и кликбейта.',
  'Заголовок — одна строка жирным с подходящим эмодзи; у каждой новости 1–3 предложения: что, где, когда, сколько стоит.',
  'Акции и события — с адресом, датами и условиями, если они есть в материалах.',
  'В конце каждой новости — ссылка на источник: [Fuente](url).',
].join('\n');

export function createChannels(deps: ChannelsDeps) {
  const { db } = deps;
  const raw = db.raw;
  const now = deps.now ?? Date.now;
  raw.exec(`CREATE TABLE IF NOT EXISTS channel_desks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL UNIQUE, title TEXT NOT NULL, username TEXT, account_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, language TEXT NOT NULL DEFAULT 'español', about TEXT NOT NULL DEFAULT '',
    editor_prompt TEXT NOT NULL DEFAULT '', slots TEXT NOT NULL DEFAULT '[]', autopublish INTEGER NOT NULL DEFAULT 0,
    threshold REAL NOT NULL DEFAULT 0.6, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id INTEGER NOT NULL REFERENCES channel_desks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, title TEXT NOT NULL, target TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, interval_min INTEGER NOT NULL,
    last_run_at INTEGER, last_error TEXT, found INTEGER NOT NULL DEFAULT 0,
    tg_chat_id INTEGER, cursor INTEGER NOT NULL DEFAULT 0, -- telegram: the chat and the last message read
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id INTEGER NOT NULL REFERENCES channel_desks(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL, kind TEXT, title TEXT NOT NULL, text TEXT NOT NULL, url TEXT, image TEXT,
    title_key TEXT NOT NULL, published_at INTEGER NOT NULL, score REAL, status TEXT NOT NULL DEFAULT 'new', created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS channel_items_url ON channel_items(desk_id, url) WHERE url IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS channel_items_title ON channel_items(desk_id, title_key);
  CREATE INDEX IF NOT EXISTS channel_items_fresh ON channel_items(desk_id, status, published_at);
  CREATE TABLE IF NOT EXISTS channel_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    desk_id INTEGER NOT NULL REFERENCES channel_desks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, text TEXT NOT NULL, image TEXT, item_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft', error TEXT, message_id INTEGER, published_at INTEGER, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS channel_slot_runs (desk_id INTEGER NOT NULL, slot_key TEXT NOT NULL, PRIMARY KEY(desk_id, slot_key));`);

  const desk = (id: number) => {
    const r = raw.prepare('SELECT * FROM channel_desks WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error('Канал не найден');
    return toDesk(r);
  };
  const listDesks = () => (raw.prepare('SELECT * FROM channel_desks ORDER BY id').all() as Row[]).map(toDesk);
  const listSources = (deskId: number) => (raw.prepare('SELECT * FROM channel_sources WHERE desk_id = ? ORDER BY id').all(deskId) as Row[]).map(toSource);
  const post = (id: number) => toPost(raw.prepare('SELECT * FROM channel_posts WHERE id = ?').get(id) as Row);

  // ---- collecting ----

  async function fetchText(url: string): Promise<{ body: string; type: string }> {
    const u = assertPublicHttpUrl(url);
    const res = await (deps.fetchFn ?? fetch)(u.toString(), {
      redirect: 'follow', signal: AbortSignal.timeout(30_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { body: await res.text(), type: res.headers.get('content-type') ?? '' };
  }

  // Web search answers carry short-lived redirect links (Google grounding): a post gets the site's own address
  async function finalUrl(url: string): Promise<string> {
    if (!/grounding-api-redirect|vertexaisearch\.cloud\.google\.com/.test(url)) return url;
    try {
      const res = await (deps.fetchFn ?? fetch)(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
      return res.headers.get('location') || url;
    } catch {
      return url;
    }
  }

  // A page's text → separate items (news, deals, events) by the model; only what the text says
  async function extract(d: ChannelDesk, pageUrl: string, text: string): Promise<Found[]> {
    if (text.trim().length < 80) return [];
    const raw0 = await deps.llm([
      `Это текст из ${pageUrl}. Вытащи из него отдельные свежие материалы — новости, акции и скидки, события, — которые могут`,
      `заинтересовать аудиторию канала: ${d.about || 'городские новости'}.`,
      'Только то, что прямо есть в тексте: не выдумывай и не дополняй. Пропусти меню сайта, рекламу, старое и общие слова.',
      'Заголовок и текст — на языке оригинала (испанский остаётся испанским), не переводи.',
      'Ответ — только JSON-массив: [{"title": "заголовок", "text": "суть в 1–4 предложениях: что, где, когда, условия", "url": "ссылка на сам материал, если есть в тексте", "date": "ГГГГ-ММ-ДД, если указана"}].',
      '',
      text.slice(0, 24000),
    ].join('\n'), { json: true, role: 'fast', title: 'channel-extract' });
    const list = parseJsonFromLlm(raw0) as { title?: string; text?: string; url?: string; date?: string }[];
    return (Array.isArray(list) ? list : []).filter((x) => x.title || x.text).map((x) => {
      const date = x.date ? Date.parse(x.date) : NaN;
      return {
        title: String(x.title ?? '').slice(0, 300), text: String(x.text ?? '').slice(0, 2000),
        url: x.url && /^https?:/.test(x.url) ? x.url : /^https?:/.test(pageUrl) ? pageUrl : null, image: null,
        publishedAt: Number.isFinite(date) ? date : now(),
      };
    });
  }

  async function collectSource(s: Row, d: ChannelDesk): Promise<Found[]> {
    const since = s.last_run_at ? s.last_run_at - 3600_000 : now() - FIRST_READ_MS;
    switch (s.kind as ChannelSource['kind']) {
      case 'rss': {
        const { body } = await fetchText(s.target);
        return parseFeed(body).filter((e) => e.publishedAt >= now() - FIRST_READ_MS);
      }
      case 'web': {
        const { body, type } = await fetchText(s.target);
        return extract(d, s.target, type.includes('html') || /<html/i.test(body.slice(0, 500)) ? htmlText(body) : body);
      }
      case 'browser': {
        if (!deps.browse) throw new Error('браузер доступен только в приложении');
        return extract(d, s.target, await deps.browse(s.target));
      }
      case 'search': {
        if (!deps.search) throw new Error('поиск не настроен: нужен ключ Tavily или Gemini в настройках');
        // results are whole pages (listicles, shop sites): the model picks the concrete news, deals and events out of them
        const results = await deps.search(s.target);
        const text = results.map((r) => `### ${r.title}\nСсылка: ${r.url}\n${r.content.slice(0, 3000)}`).join('\n\n');
        const found = (await extract(d, `поиск «${s.target}»`, text)).filter((f) => f.url); // a post needs a link to point to
        return Promise.all(found.map(async (f) => ({ ...f, url: await finalUrl(f.url!) })));
      }
      case 'telegram': {
        let chatId = s.tg_chat_id as number | null;
        if (!chatId) {
          chatId = (await deps.engine.resolveChat(d.accountId, s.target)).chatId;
          raw.prepare('UPDATE channel_sources SET tg_chat_id = ? WHERE id = ?').run(chatId, s.id);
        }
        const msgs = await deps.engine.getHistory(d.accountId, chatId, since, s.cursor || null, 50);
        if (msgs.length) raw.prepare('UPDATE channel_sources SET cursor = ? WHERE id = ?').run(Math.max(...msgs.map((m) => m.messageId)), s.id);
        const out: Found[] = [];
        for (const m of msgs) {
          if (m.isOutgoing || m.text.trim().length < MIN_TELEGRAM_TEXT) continue;
          let image: string | null = null;
          if (m.photo) {
            image = await deps.engine.downloadFile(d.accountId, m.photo.fileId).then((p) => keepImage(d.id, p), () => null);
          }
          out.push({ title: m.text.split('\n')[0].slice(0, 160), text: m.text.slice(0, 2500), url: m.link, image, publishedAt: m.date });
        }
        return out;
      }
    }
  }

  function keepImage(deskId: number, path: string): string {
    const dir = join(deps.dataDir, 'channels', String(deskId), 'images');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${Date.now()}-${Math.round(Math.random() * 1e6)}${extname(path) || '.jpg'}`);
    copyFileSync(path, dest);
    return dest;
  }

  // New items in; the ones already seen (same link or headline) are skipped by the unique indexes
  function store(deskId: number, sourceId: number, found: Found[]): number {
    const insert = raw.prepare(`INSERT OR IGNORE INTO channel_items(desk_id, source_id, title, text, url, image, title_key, published_at, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    for (const f of found) {
      const key = titleKey(f.title || f.text.slice(0, 120));
      if (!key) continue;
      added += Number(insert.run(deskId, sourceId, f.title || f.text.slice(0, 120), f.text, f.url, f.image, key, f.publishedAt, now()).changes);
    }
    if (added) raw.prepare('UPDATE channel_sources SET found = found + ? WHERE id = ?').run(added, sourceId);
    return added;
  }

  async function runSource(id: number): Promise<number> {
    const s = raw.prepare('SELECT * FROM channel_sources WHERE id = ?').get(id) as Row;
    const d = desk(s.desk_id);
    try {
      const added = store(d.id, s.id, await collectSource(s, d));
      raw.prepare('UPDATE channel_sources SET last_run_at = ?, last_error = NULL WHERE id = ?').run(now(), id);
      if (added) await scorePending(d);
      return added;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      raw.prepare('UPDATE channel_sources SET last_run_at = ?, last_error = ? WHERE id = ?').run(now(), error.slice(0, 300), id);
      console.warn(`channel source ${s.title}: ${error}`);
      return 0;
    }
  }

  // Jev on the new items: fits the channel or not, and what it is
  async function scorePending(d: ChannelDesk) {
    for (;;) {
      const rows = raw.prepare('SELECT * FROM channel_items WHERE desk_id = ? AND score IS NULL ORDER BY id LIMIT ?').all(d.id, SCORE_BATCH) as Row[];
      if (!rows.length) return;
      let verdicts: { p: number; kind: ChannelItemKind | 'other' }[];
      try {
        verdicts = await deps.score(d.about, rows.map((r) => ({ title: r.title, text: r.text.slice(0, 900) })));
      } catch (err) {
        console.warn('channel scoring', err instanceof Error ? err.message : err);
        return; // next round
      }
      rows.forEach((r, i) => {
        const v = verdicts[i] ?? { p: 0, kind: 'other' };
        const keep = v.kind !== 'other' && v.p >= d.threshold;
        raw.prepare('UPDATE channel_items SET score = ?, kind = ?, status = ? WHERE id = ?')
          .run(v.p, v.kind === 'other' ? null : v.kind, keep ? 'new' : 'skipped', r.id);
      });
    }
  }

  // ---- posts ----

  function pickItems(d: ChannelDesk, kind: ChannelSlotKind): ChannelItem[] {
    const kinds = kind === 'deals' ? ['deal', 'event'] : kind === 'top' ? ['news'] : ['news', 'event', 'deal'];
    const rows = raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i JOIN channel_sources s ON s.id = i.source_id
      WHERE i.desk_id = ? AND i.status = 'new' AND i.score >= ? AND i.published_at >= ? AND i.kind IN (${kinds.map(() => '?').join(',')})
      ORDER BY i.score DESC, i.published_at DESC LIMIT ?`).all(d.id, d.threshold, now() - FRESH_MS, ...kinds, POST_ITEMS[kind]) as Row[];
    return rows.map(toItem);
  }

  async function compose(deskId: number, kind: ChannelSlotKind, itemIds?: number[]): Promise<ChannelPost> {
    const d = desk(deskId);
    const items = itemIds?.length
      ? (raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i JOIN channel_sources s ON s.id = i.source_id
          WHERE i.id IN (${itemIds.map(() => '?').join(',')})`).all(...itemIds) as Row[]).map(toItem)
      : pickItems(d, kind);
    if (!items.length) throw new Error('Нет свежих подходящих материалов для поста');
    const what = kind === 'digest'
      ? 'дайджест главных новостей: короткое вступление и по пункту на новость'
      : kind === 'deals' ? 'подборку акций, скидок и событий: что, где, когда, условия' : 'один пост о главной новости, подробнее';
    const text = (await deps.llm([
      `Ты — редактор Telegram-канала. О канале и аудитории: ${d.about || '—'}.`,
      `Напиши ${what}. Язык поста — ${d.language}, даже если материалы на другом.`,
      // the editor's rules may differ by post kind and time of day («good morning» only in the morning)
      `Вид поста: ${kind} — «${CHANNEL_SLOT_KINDS[kind]}». Сейчас ${new Date(now()).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Из правил редактора применяй только те, что подходят этому виду поста.`,
      d.editorPrompt || DEFAULT_EDITOR,
      'Факты, цифры, даты, адреса и цены — только из материалов; чего в них нет, не добавляй. Не упоминай, что пишешь по материалам.',
      'Формат — Markdown для Telegram (жирный, списки, ссылки [текст](url)); без заголовков «#». Ответ — только текст поста.',
      '',
      ...items.map((it, i) => `<item n="${i + 1}" kind="${it.kind}" source="${it.sourceTitle}" url="${it.url ?? ''}" date="${new Date(it.publishedAt).toISOString().slice(0, 16)}">\n${it.title}\n${it.text.slice(0, 1500)}\n</item>`),
    ].join('\n'), { role: 'chat', title: 'channel-post' })).trim();
    if (!text) throw new Error('Редактор вернул пустой пост');
    const image = items.find((it) => it.image)?.image ?? null;
    const id = Number(raw.prepare('INSERT INTO channel_posts(desk_id, kind, text, image, item_ids, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(d.id, kind, text, image, JSON.stringify(items.map((i) => i.id)), now()).lastInsertRowid);
    raw.prepare(`UPDATE channel_items SET status = 'used' WHERE id IN (${items.map(() => '?').join(',')})`).run(...items.map((i) => i.id));
    deps.emit({ type: 'job', projectId: 0, stage: `Канал «${d.title}»: ${d.autopublish ? 'пост готов' : 'черновик поста ждёт одобрения'}`, done: true });
    return post(id);
  }

  async function localImage(deskId: number, image: string | null): Promise<string | null> {
    if (!image) return null;
    if (!/^https?:/.test(image)) return image;
    try {
      const res = await (deps.fetchFn ?? fetch)(image, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const dir = join(deps.dataDir, 'channels', String(deskId), 'images');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now()}.jpg`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
      return path;
    } catch {
      return null; // a post without a picture is still a post
    }
  }

  // Through the account's limiter like every outgoing message: channel posts are not cold messages — no daily cap,
  // the pause is kept
  async function publish(id: number): Promise<ChannelPost> {
    const p = post(id);
    if (p.status === 'published') return p;
    const d = desk(p.deskId);
    try {
      for (;;) {
        const gate = canSend(db.getAccount(d.accountId), now(), true);
        if (gate.ok) break;
        await new Promise((r) => setTimeout(r, (gate.reason === 'pause' ? gate.waitMs ?? 1000 : 60_000) + 300));
      }
      const img = await localImage(d.id, p.image);
      const msg = await deps.engine.sendToChat(d.accountId, d.chatId, img ? `![](${img})\n\n${p.text}` : p.text);
      db.updateAccount(d.accountId, afterSend(db.getAccount(d.accountId), now(), true));
      raw.prepare("UPDATE channel_posts SET status = 'published', message_id = ?, published_at = ?, error = NULL WHERE id = ?").run(msg.messageId, now(), id);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      raw.prepare("UPDATE channel_posts SET status = 'failed', error = ? WHERE id = ?").run(error.slice(0, 500), id);
      console.error(`channel post ${id}: ${error}`);
    }
    return post(id);
  }

  function addDesk(accountId: number, chat: { chatId: number; title: string; username: string | null }): ChannelDesk {
    raw.prepare(`INSERT OR IGNORE INTO channel_desks(chat_id, title, username, account_id, editor_prompt, slots, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(chat.chatId, chat.title, chat.username ?? null, accountId, DEFAULT_EDITOR,
      JSON.stringify([{ time: '09:00', kind: 'digest' }, { time: '19:00', kind: 'deals' }]), now());
    return toDesk(raw.prepare('SELECT * FROM channel_desks WHERE chat_id = ?').get(chat.chatId) as Row);
  }

  // ---- the clock ----

  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const t = now();
      for (const d of listDesks().filter((x) => x.enabled)) {
        // sources that are due, one at a time (gentle on sites and on the Telegram account)
        for (const s of raw.prepare('SELECT * FROM channel_sources WHERE desk_id = ? AND enabled = 1').all(d.id) as Row[]) {
          if (!s.last_run_at || t - s.last_run_at >= s.interval_min * 60_000) await runSource(s.id);
        }
        // slots: today's time has come, not done yet, and not more than an hour late
        const today = new Date(t);
        for (const slot of d.slots) {
          const [h, m] = slot.time.split(':').map(Number);
          const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m).getTime();
          if (t < at || t - at > LATE_SLOT_MS) continue;
          const key = `${dayKey(today)} ${slot.time}`;
          if (raw.prepare('SELECT 1 FROM channel_slot_runs WHERE desk_id = ? AND slot_key = ?').get(d.id, key)) continue;
          raw.prepare('INSERT INTO channel_slot_runs(desk_id, slot_key) VALUES(?, ?)').run(d.id, key);
          try {
            const p = await compose(d.id, slot.kind);
            if (d.autopublish) await publish(p.id);
          } catch (err) {
            console.warn(`channel «${d.title}» slot ${slot.time}:`, err instanceof Error ? err.message : err);
          }
        }
      }
    } finally {
      running = false;
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      timer = setInterval(() => void tick().catch((err) => console.error('channels tick', err)), TICK_MS);
      setTimeout(() => void tick().catch(() => {}), 20_000).unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    desks: listDesks,
    async createChannel(accountId: number, opts: { title: string; description: string; username?: string; photo?: string }): Promise<ChannelDesk> {
      if (!opts.title.trim()) throw new Error('Укажите название канала');
      return addDesk(accountId, await deps.engine.createChannel(accountId, opts));
    },
    async createDesk(accountId: number, link: string): Promise<ChannelDesk> {
      const chat = await deps.engine.resolveChat(accountId, link.trim());
      if (chat.kind !== 'channel') throw new Error('Нужен канал: помощник публикует посты в канал');
      if (chat.isAdmin === false) throw new Error('Аккаунт не администратор этого канала: публиковать посты он не сможет');
      return addDesk(accountId, chat);
    },
    saveDesk(d: ChannelDesk): ChannelDesk[] {
      raw.prepare(`UPDATE channel_desks SET enabled = ?, account_id = ?, language = ?, about = ?, editor_prompt = ?, slots = ?, autopublish = ?, threshold = ?
        WHERE id = ?`).run(d.enabled ? 1 : 0, d.accountId, d.language, d.about, d.editorPrompt, JSON.stringify(d.slots), d.autopublish ? 1 : 0, d.threshold, d.id);
      return listDesks();
    },
    removeDesk(id: number): ChannelDesk[] {
      for (const t of ['channel_items', 'channel_posts', 'channel_sources', 'channel_slot_runs']) raw.prepare(`DELETE FROM ${t} WHERE desk_id = ?`).run(id);
      raw.prepare('DELETE FROM channel_desks WHERE id = ?').run(id);
      return listDesks();
    },
    sources: listSources,
    saveSource(s: Omit<ChannelSource, 'id' | 'lastRunAt' | 'lastError' | 'found' | 'createdAt'> & { id?: number }): ChannelSource[] {
      if (!s.target.trim()) throw new Error('Укажите источник');
      const interval = s.intervalMin || CHANNEL_SOURCE_KINDS[s.kind].interval;
      if (s.id) {
        raw.prepare('UPDATE channel_sources SET title = ?, target = ?, enabled = ?, interval_min = ? WHERE id = ?').run(s.title || s.target, s.target.trim(), s.enabled ? 1 : 0, interval, s.id);
      } else {
        raw.prepare('INSERT INTO channel_sources(desk_id, kind, title, target, enabled, interval_min, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
          .run(s.deskId, s.kind, s.title || s.target, s.target.trim(), s.enabled ? 1 : 0, interval, now());
      }
      return listSources(s.deskId);
    },
    removeSource(id: number) {
      raw.prepare('DELETE FROM channel_items WHERE source_id = ?').run(id);
      raw.prepare('DELETE FROM channel_sources WHERE id = ?').run(id);
    },
    runSource,
    items(deskId: number, limit = 100): ChannelItem[] {
      return (raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i LEFT JOIN channel_sources s ON s.id = i.source_id
        WHERE i.desk_id = ? ORDER BY i.published_at DESC LIMIT ?`).all(deskId, limit) as Row[]).map(toItem);
    },
    setItemStatus(id: number, status: ChannelItem['status']) {
      raw.prepare('UPDATE channel_items SET status = ? WHERE id = ?').run(status, id);
    },
    posts(deskId: number, limit = 30): ChannelPost[] {
      return (raw.prepare('SELECT * FROM channel_posts WHERE desk_id = ? ORDER BY id DESC LIMIT ?').all(deskId, limit) as Row[]).map(toPost);
    },
    compose,
    savePost(id: number, text: string): ChannelPost {
      raw.prepare("UPDATE channel_posts SET text = ? WHERE id = ? AND status <> 'published'").run(text, id);
      return post(id);
    },
    publish,
    // a rejected draft gives its items back
    rejectPost(id: number) {
      const p = post(id);
      raw.prepare("UPDATE channel_posts SET status = 'rejected' WHERE id = ?").run(id);
      if (p.itemIds.length) raw.prepare(`UPDATE channel_items SET status = 'new' WHERE id IN (${p.itemIds.map(() => '?').join(',')})`).run(...p.itemIds);
    },
  };
}

export type Channels = ReturnType<typeof createChannels>;

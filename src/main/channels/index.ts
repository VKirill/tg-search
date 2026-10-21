// The channel assistant: a news desk for the owner's Telegram channel. Sources are collected non-stop, each on its own
// interval; new items are de-duplicated (by link and by headline) and grouped into stories — the same news from several
// sources is one story (local embeddings); Jev scores each story once — does it fit the channel, does it happen in the
// channel's area, is it news, a deal or an event, which rubric; at each slot's time the editor writes a post from the
// best fresh stories in the channel's language — by default as the channel's own stories, with no links or sources —
// and it is published (or waits for approval as a draft).
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type {
  AppEvent, ChannelAudience, ChannelCalendarEntry, ChannelCategory, ChannelDesk, ChannelFeedStats, ChannelItem, ChannelItemKind, ChannelPost, ChannelSlot, ChannelSlotKind,
  ChannelSource, ChannelStory, Settings,
} from '../../shared/types';
import { CHANNEL_SLOT_KINDS, CHANNEL_SOURCE_KINDS, channelCategoryName, DEFAULT_CHANNEL_AUDIENCES, DEFAULT_CHANNEL_CATEGORIES } from '../../shared/types';
import { dot } from '../memory/embedder';
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
const GNEWS_ITEMS = 25; // newest Google News results per read
const ENRICH_ITEMS = 4; // listings looked up on the web per post
const POST_ITEMS: Record<ChannelSlotKind, number> = { digest: 8, deals: 6, top: 1, alert: 1 };
const LISTING_FLOOR = 0.34; // events and deals: kept unless of no interest — the channel's threshold only ranks them for posts
const PLACE_DOUBT: [number, number] = [0.1, 0.85]; // Jev unsure where it happens: a model that knows the map checks
const ALERT_SCORE = 0.75; // Jev: urgent for residents today
const ALERTS_PER_DAY = 4;
const ALERT_FRESH_MS = 6 * 3600_000;
const STORY_WINDOW_MS = 3 * 86400_000; // a story is matched against what was found in the last three days
// Embeddings find candidates, Jev decides: news on one topic (a flood's aid packages) is as close as one story's retellings
export const STORY_CANDIDATE = 0.82; // cosine similarity worth asking about
export const SAME_STORY = 0.9; // without Jev: only near-identical retellings

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
  // Jev: for each item — how much the channel's readers want it (0–1), whether it happens in the channel's area, what it is,
  // its rubric, whether it is already over (an event ended, an offer expired)
  score: (desk: { about: string; area: string; categories: ChannelCategory[]; audiences: ChannelAudience[] }, items: { title: string; text: string; publishedAt: number; source: string }[]) =>
    Promise<{ p: number; local: number | null; kind: ChannelItemKind | 'other'; category: string | null; audiences: string[]; urgent?: number; over?: number }[]>;
  embed?: (text: string) => Promise<Float32Array | null>; // local embeddings: the same story from different sources
  // Jev: for each candidate — the probability it reports the same event as `item`; absent — similarity alone decides
  cover?: (prompt: string, deskId: number) => Promise<string | null>; // draws a cover (Muse Image), the file's path
  sameStory?: (item: { title: string; text: string }, candidates: { title: string; text: string }[]) => Promise<number[]>;
  search?: (query: string) => Promise<{ title: string; url: string; content: string }[]>;
  browse?: (url: string) => Promise<string>; // the page's text in the app's browser with the owner's login
  fetchFn?: typeof fetch;
  now?: () => number;
}

type Row = Record<string, any>;

// An article page → its text: the paragraphs long enough to be prose (menus, captions and footers are short)
export function articleText(html: string): string {
  const paragraphs = [...html.matchAll(/<p[\s>][\s\S]*?<\/p>/gi)]
    .map((m) => htmlText(m[0]).replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 80 && !/cookies?|suscr[ií]b|newsletter|©/i.test(t));
  return paragraphs.join('\n').slice(0, 3000);
}

const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().slice(0, 90);
const partOfDay = (t: number) => {
  const h = new Date(t).getHours();
  return h < 5 ? 'ночь' : h < 12 ? 'утро' : h < 18 ? 'день' : 'вечер';
};

// «YYYY-MM-DD HH:MM» of a slot on a day, and back to a local time
const slotTime = (key: string) => {
  const [y, mo, d, h, mi] = key.split(/[- :]/).map(Number);
  return new Date(y, mo - 1, d, h, mi).getTime();
};
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const toDesk = (r: Row): ChannelDesk => ({
  id: r.id, chatId: r.chat_id, title: r.title, username: r.username, accountId: r.account_id, enabled: !!r.enabled,
  language: r.language, about: r.about, editorPrompt: r.editor_prompt, slots: JSON.parse(r.slots), autopublish: !!r.autopublish,
  threshold: r.threshold, area: r.area ?? '', links: r.links === 'sources' ? 'sources' : 'none',
  categories: r.categories ? JSON.parse(r.categories) : DEFAULT_CHANNEL_CATEGORIES,
  audiences: r.audiences ? JSON.parse(r.audiences) : DEFAULT_CHANNEL_AUDIENCES, alerts: r.alerts === 1, cover: r.cover !== 0, coverStyle: r.cover_style ?? '',
  createdAt: r.created_at,
});
const toSource = (r: Row): ChannelSource => ({
  id: r.id, deskId: r.desk_id, kind: r.kind, title: r.title, target: r.target, enabled: !!r.enabled, intervalMin: r.interval_min,
  lastRunAt: r.last_run_at, lastError: r.last_error, found: r.found, createdAt: r.created_at,
});
const toItem = (r: Row): ChannelItem => ({
  id: r.id, deskId: r.desk_id, sourceId: r.source_id, sourceTitle: r.source_title ?? '', kind: r.kind, title: r.title, text: r.text,
  url: r.url, image: r.image, publishedAt: r.published_at, score: r.score, local: r.local ?? null, category: r.category ?? null,
  storyId: r.story_id ?? null, audiences: r.audiences ? JSON.parse(r.audiences) : [], status: r.status, createdAt: r.created_at,
});
const toPost = (r: Row): ChannelPost => ({
  id: r.id, deskId: r.desk_id, kind: r.kind, text: r.text, image: r.image, itemIds: JSON.parse(r.item_ids), status: r.status,
  scheduledAt: r.scheduled_at ?? null, slotKey: r.slot_key ?? null, error: r.error, messageId: r.message_id, publishedAt: r.published_at, createdAt: r.created_at,
});

export const DEFAULT_EDITOR = [
  'Пиши как живой городской редактор: коротко, по делу, с характером, без канцелярита и кликбейта.',
  'Заголовок — одна строка жирным с подходящим эмодзи; у каждой новости 1–3 предложения: что, где, когда, сколько стоит.',
  'Акции и события — с адресом, датами и условиями, если они есть в материалах.',
].join('\n');

// The channel's own stories: no way out of the channel — links, sources, other channels and social networks
const OWN_STORIES = [
  'Это собственные материалы редакции канала. Никаких ссылок, никаких упоминаний источников, СМИ, чужих Telegram-каналов,',
  'сайтов и соцсетей — ни «según…», ни «fuente», ни «vía», ни «más info en…». Всё, что нужно читателю, — в самом тексте:',
  'что, где (адрес или район), когда (даты, часы), сколько стоит, как попасть или записаться. Пересказывай своими словами, не копируй фразы.',
].join('\n');

export interface IssueItem {
  emoji: string;
  title: string;
  text: string;
  when: string;
  where: string;
  price: string;
  tags: string[];
  story?: number; // which story of the materials it tells (1-based), for the places step
  places: { name: string; where: string }[]; // several venues of one story (Open House buildings, a route): a folded list
  placesTitle: string;
  source?: string;
}
export interface Issue {
  title: string;
  lead: string;
  sections: { title: string; items: IssueItem[] }[];
  footer: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

export function parseIssue(raw: string): Issue {
  const j = parseJsonFromLlm(raw) as Record<string, any>;
  const sections = (Array.isArray(j?.sections) ? j.sections : []).map((sec: any) => ({
    title: str(sec?.title),
    items: (Array.isArray(sec?.items) ? sec.items : []).map((it: any) => ({
      emoji: str(it?.emoji), title: str(it?.title), text: str(it?.text), when: str(it?.when), where: str(it?.where), price: str(it?.price),
      tags: (Array.isArray(it?.tags) ? it.tags : []).map(str).filter((t: string) => /\p{L}/u.test(t)).slice(0, 2), // «🆓» alone says nothing
      places: (Array.isArray(it?.places) ? it.places : []).map((p: any) => ({ name: str(p?.name), where: str(p?.where) || str(p?.name) })).filter((p: { name: string }) => p.name).slice(0, 25),
      placesTitle: str(it?.placesTitle),
      ...(Number.isInteger(Number(it?.story)) && Number(it?.story) > 0 ? { story: Number(it.story) } : {}),
      ...(str(it?.source) ? { source: str(it?.source) } : {}),
    })).filter((it: IssueItem) => it.title),
  })).filter((sec: { items: IssueItem[] }) => sec.items.length);
  return { title: str(j?.title), lead: str(j?.lead), sections, footer: str(j?.footer) };
}

const mapIssue = (i: Issue, f: (t: string) => string): Issue => ({
  title: f(i.title), lead: f(i.lead), footer: f(i.footer),
  sections: i.sections.map((sec) => ({ title: f(sec.title), items: sec.items.map((it) => ({
    ...it, title: f(it.title), text: f(it.text), when: f(it.when), where: f(it.where), price: f(it.price), tags: it.tags.map(f).filter(Boolean),
    placesTitle: f(it.placesTitle), places: it.places.map((p) => ({ name: f(p.name), where: f(p.where) })).filter((p) => p.name),
  })) })),
});

// The proofreader's fixes on the editor's issue: a field set, an item dropped; anything malformed is ignored
export function applyFixes(issue: Issue, f: { fixes?: unknown[]; drop?: unknown[] }): Issue {
  const out: Issue = JSON.parse(JSON.stringify(issue));
  const fields = new Set(['title', 'text', 'when', 'where', 'price', 'tags', 'places']);
  for (const x of (Array.isArray(f.fixes) ? f.fixes : []) as Record<string, unknown>[]) {
    if (x?.field === 'lead') out.lead = str(x.value);
    if (x?.field === 'issueTitle') out.title = str(x.value) || out.title;
    const it = out.sections[Number(x?.section)]?.items[Number(x?.item)] as unknown as Record<string, unknown> | undefined;
    const field = String(x?.field ?? '');
    if (!it || !fields.has(field)) continue;
    if (field === 'tags') it.tags = Array.isArray(x.value) ? x.value.map(str).filter((t) => /\p{L}/u.test(t)).slice(0, 2) : [];
    else if (field === 'places') it.places = Array.isArray(x.value) ? (x.value as any[]).map((p) => ({ name: str(p?.name), where: str(p?.where) || str(p?.name) })).filter((p) => p.name) : [];
    else it[field] = str(x.value);
  }
  const drop = new Set(((Array.isArray(f.drop) ? f.drop : []) as Record<string, unknown>[]).map((x) => `${Number(x?.section)}:${Number(x?.item)}`));
  out.sections = out.sections
    .map((sec, si) => ({ ...sec, items: sec.items.filter((it, ii) => it.title && !drop.has(`${si}:${ii}`)) }))
    .filter((sec) => sec.items.length);
  return out;
}

// A place worth a map link: an address (a number in it), or one venue with its town — not «the city», not a list of places
export const isPlace = (where: string) =>
  /\d/.test(where) || ((where.match(/,/g)?.length ?? 0) === 1 && !/\s(y|i|and|e|и)\s|;|\//i.test(where));

// Google Maps search for a place as people would type it: the reader gets there in one tap
export const mapsLink = (where: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(where)}`;

// The issue as a Rich Message: the title, the lead as a quote, sections divided by rules, each item — a small heading,
// the gist, and a line «tags · 🗓 when · 📍 place (on the map) · 💶 price»
export function renderIssue(issue: Issue, o: { own: boolean; username: string | null }): string {
  const out: string[] = [];
  const items = issue.sections.flatMap((sec) => sec.items);
  // one story: its own title on top — no issue header, no section, no repeated heading
  const single = items.length === 1 ? items[0] : null;
  // the issue's title H1, sections H2 with their emoji, items H5 without — small item titles, the emoji marks the section
  if (single) out.push(`# ${single.title}`, '');
  else if (issue.title) out.push(`# ${issue.title}`, '');
  if (issue.lead) out.push(`> ${issue.lead}`, '');
  for (const sec of issue.sections) {
    if (!single) {
      out.push('---', '');
      if (sec.title) out.push(`## ${sec.title}`, '');
    }
    for (const it of sec.items) {
      // the item's title is a small heading: Telegram gives headings room above, plain paragraphs sit back to back
      const head = `##### ${it.title}`;
      const meta = [
        ...it.tags,
        it.when && `🗓 ${it.when}`,
        // a map link only for a real place (a venue with its town, an address), not for «the city» or a region
        it.where && (isPlace(it.where) ? `📍 [${it.where}](${mapsLink(it.where)})` : `📍 ${it.where}`),
        it.price && `💶 ${it.price}`,
        !o.own && it.source && /^https?:/.test(it.source) ? `[↗](${it.source})` : '',
      ].filter(Boolean).join(' · ');
      if (!single) out.push(head, '');
      out.push([it.text, meta && `*${meta}*`].filter(Boolean).join('\n'), '');
      // several places of one story: folded, each on the map
      if (it.places.length > 2) {
        out.push(`<details><summary>${it.placesTitle || `📍 ${it.places.length}`}</summary>`, '');
        out.push(...it.places.map((p) => `- [${p.name}](${mapsLink(p.where)})`), '', '</details>', '');
      }
    }
  }
  // the channel's signature: the editor's, or at least the channel's @name — subscribers come from forwards
  const footer = issue.footer || (o.username ? `📲 @${o.username}` : '');
  if (footer) out.push('---', '', footer);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// What the model may still slip in: links become their text («Más info» and the like disappear), bare URLs and
// other channels' @names go; the channel's own @name stays
export function stripLinks(text: string, own: string | null): string {
  const generic = /^(m[aá]s info(rmaci[oó]n)?|fuente|source|link|enlace|ver|leer m[aá]s|aqu[ií]|подробнее|источник|ссылка)$/i;
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, label: string) => (generic.test(label.trim()) ? '' : label))
    .replace(/https?:\/\/\S+|(?:^|\s)(?:www\.|t\.me\/)\S+/gi, '')
    .replace(/@([A-Za-z0-9_]{4,})/g, (m, name: string) => (own && name.toLowerCase() === own.toLowerCase() ? m : ''))
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n').map((l) => l.trimEnd()).filter((l, i, all) => !(/^[\s→:·•\-–—]*$/.test(l) && l !== '' ) && !(l === '' && all[i - 1] === ''))
    .join('\n').trim();
}

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
  for (const [table, column] of [
    ['channel_desks', 'area TEXT NOT NULL DEFAULT \'\''], ['channel_desks', 'links TEXT NOT NULL DEFAULT \'none\''], ['channel_desks', 'categories TEXT'],
    ['channel_desks', 'audiences TEXT'], ['channel_items', 'audiences TEXT'], ['channel_posts', 'scheduled_at INTEGER'], ['channel_posts', 'slot_key TEXT'],
    ['channel_slot_runs', 'post_id INTEGER'], ['channel_desks', 'cover INTEGER NOT NULL DEFAULT 1'], ['channel_desks', 'alerts INTEGER NOT NULL DEFAULT 0'], ['channel_items', 'urgent REAL'], ['channel_posts', 'issue TEXT'], ['channel_desks', 'cover_style TEXT NOT NULL DEFAULT \'\''],
    ['channel_items', 'local REAL'], ['channel_items', 'category TEXT'], ['channel_items', 'story_id INTEGER'], ['channel_items', 'vec BLOB'],
  ]) {
    try {
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    } catch {
      /* already there */
    }
  }
  raw.exec('CREATE INDEX IF NOT EXISTS channel_items_story ON channel_items(story_id)');

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

  // Google News: the search's RSS (every outlet, last day); each article's real address is asked from Google (the RSS link
  // is an encoded redirect), and the article's paragraphs become the item's text. Already known headlines are not fetched.
  async function googleNews(d: ChannelDesk, query: string, deskId: number): Promise<Found[]> {
    const lang = /espa|spanish|españ/i.test(d.language) ? ['es', 'ES'] : /рус|russ/i.test(d.language) ? ['ru', 'RU'] : /engl|англ/i.test(d.language) ? ['en', 'US'] : ['es', 'ES'];
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:1d`)}&hl=${lang[0]}&gl=${lang[1]}&ceid=${lang[1]}:${lang[0]}`;
    const entries = parseFeed((await fetchText(url)).body).slice(0, GNEWS_ITEMS);
    const known = raw.prepare('SELECT 1 FROM channel_items WHERE desk_id = ? AND title_key = ?');
    const out: Found[] = [];
    for (const e of entries) {
      const title = e.title.replace(/\s+-\s+[^-]+$/, '').trim(); // «Headline - Outlet»
      if (!title || known.get(deskId, titleKey(title))) continue;
      const article = e.url ? await googleNewsUrl(e.url).catch(() => null) : null;
      const text = article ? await fetchText(article).then((r) => articleText(r.body), () => '') : '';
      out.push({ title, text: text || title, url: article ?? e.url, image: null, publishedAt: e.publishedAt });
    }
    return out;
  }

  async function googleNewsUrl(link: string): Promise<string | null> {
    const id = /\/articles\/([^?]+)/.exec(link)?.[1];
    if (!id) return null;
    const f = deps.fetchFn ?? fetch;
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';
    const page = await (await f(`https://news.google.com/rss/articles/${id}`, {
      headers: { 'User-Agent': ua, Cookie: 'CONSENT=YES+cb; SOCS=CAESEwgDEgk0ODE3Nzk3MjQaAmVuIAEaBgiA_LyaBg' }, signal: AbortSignal.timeout(15_000),
    })).text();
    const sg = /data-n-a-sg="([^"]+)"/.exec(page)?.[1];
    const ts = /data-n-a-ts="([^"]+)"/.exec(page)?.[1];
    if (!sg || !ts) return null;
    const inner = ['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, Number(ts), sg];
    const res = await (await f('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ 'f.req': JSON.stringify([[['Fbv4je', JSON.stringify(inner), null, 'generic']]]) }).toString(),
    })).text();
    const m = /\[\\"garturlres\\",\\"(.*?)\\"/.exec(res);
    return m ? m[1].replace(/\\\\u003d/g, '=').replace(/\\\\u0026/g, '&') : null;
  }

  // A page's text → separate items (news, deals, events) by the model; only what the text says
  async function extract(d: ChannelDesk, pageUrl: string, text: string): Promise<Found[]> {
    if (text.trim().length < 80) return [];
    const raw0 = await deps.llm([
      `Это текст из ${pageUrl}. Вытащи из него отдельные свежие материалы — новости, акции и скидки, события, — которые могут`,
      `заинтересовать аудиторию канала: ${d.about || 'городские новости'}.`,
      'Только то, что прямо есть в тексте: не выдумывай и не дополняй. Пропусти меню сайта, рекламу, старое и общие слова.',
      'Если это лента соцсети (посты X, Facebook, Instagram): каждый пост с новостью, акцией или событием — отдельный материал; мнения, споры, шутки, рекламу и репосты без новости пропусти.',
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
      case 'gnews':
        return googleNews(d, s.target, d.id);
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
      if (added) {
        await assignStories(d);
        await scorePending(d);
        await sendAlerts(d);
      }
      return added;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      raw.prepare('UPDATE channel_sources SET last_run_at = ?, last_error = ? WHERE id = ?').run(now(), error.slice(0, 300), id);
      console.warn(`channel source ${s.title}: ${error}`);
      return 0;
    }
  }

  // The same news from different sources is one story: an item close enough to one found in the last days joins its
  // story (and its fate — a story already posted is not posted again); without embeddings every item is its own story
  async function assignStories(d: ChannelDesk) {
    const rows = raw.prepare('SELECT id, title, text, published_at, vec FROM channel_items WHERE desk_id = ? AND story_id IS NULL ORDER BY id').all(d.id) as Row[];
    for (const r of rows) {
      const v = r.vec ? new Float32Array(new Uint8Array(r.vec).buffer)
        : deps.embed ? await deps.embed(`${r.title}\n${r.text.slice(0, 700)}`).catch(() => null) : null;
      let story = r.id as number;
      if (v) {
        const near = (raw.prepare(`SELECT id, story_id, title, text, vec FROM channel_items WHERE desk_id = ? AND id <> ? AND vec IS NOT NULL
          AND story_id IS NOT NULL AND published_at >= ?`).all(d.id, r.id, r.published_at - STORY_WINDOW_MS) as Row[])
          .map((n) => ({ storyId: n.story_id as number, title: n.title as string, text: n.text as string, sim: dot(v, new Float32Array(new Uint8Array(n.vec).buffer)) }))
          .filter((n) => n.sim >= STORY_CANDIDATE)
          .sort((a, b) => b.sim - a.sim)
          .filter((n, i, all) => all.findIndex((x) => x.storyId === n.storyId) === i) // one candidate per story
          .slice(0, 3);
        if (near.length) {
          const p = deps.sameStory
            ? await deps.sameStory({ title: r.title, text: r.text.slice(0, 600) }, near.map((n) => ({ title: n.title, text: n.text.slice(0, 600) }))).catch(() => null)
            : null;
          const best = p
            ? near.map((n, i) => ({ n, p: p[i] ?? 0 })).filter((x) => x.p >= 0.5).sort((a, b) => b.p - a.p)[0]?.n
            : near.find((n) => n.sim >= SAME_STORY);
          if (best) story = best.storyId;
        }
      }
      raw.prepare('UPDATE channel_items SET story_id = ?, vec = ? WHERE id = ?').run(story, v ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : null, r.id);
    }
  }

  // Jev on new stories, once per story: fits the channel, happens in its area, what it is, its rubric; later items of a
  // story take its verdict
  async function scorePending(d: ChannelDesk) {
    raw.prepare(`UPDATE channel_items AS i SET score = s.score, local = s.local, kind = s.kind, category = s.category, audiences = s.audiences,
        status = CASE WHEN s.status = 'used' THEN 'used' ELSE s.status END
      FROM channel_items AS s WHERE i.desk_id = ? AND i.score IS NULL AND i.story_id <> i.id AND s.id = i.story_id AND s.score IS NOT NULL`).run(d.id);
    for (;;) {
      const rows = raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i JOIN channel_sources s ON s.id = i.source_id
        WHERE i.desk_id = ? AND i.score IS NULL AND (i.story_id IS NULL OR i.story_id = i.id) ORDER BY i.id LIMIT ?`).all(d.id, SCORE_BATCH) as Row[];
      if (!rows.length) break;
      let verdicts: Awaited<ReturnType<ChannelsDeps['score']>>;
      try {
        verdicts = await deps.score(d, rows.map((r) => ({ title: r.title, text: r.text.slice(0, 900), publishedAt: r.published_at, source: r.source_title })));
      } catch (err) {
        console.warn('channel scoring', err instanceof Error ? err.message : err);
        return; // next round
      }
      await checkPlaces(d, rows, verdicts);
      rows.forEach((r, i) => {
        const v = verdicts[i] ?? { p: 0, local: null, kind: 'other', category: null, audiences: [] };
        // news by the channel's threshold; an event or a deal is kept while it is on, however small (a listing)
        const listing = v.kind === 'event' || v.kind === 'deal';
        const keep = v.kind !== 'other' && (v.local === null || v.local >= 0.5)
          && (listing ? (v.over ?? 0) < 0.5 && v.p >= LISTING_FLOOR : v.p >= d.threshold);
        raw.prepare('UPDATE channel_items SET score = ?, local = ?, kind = ?, category = ?, audiences = ?, urgent = ?, status = ? WHERE id = ?')
          .run(v.p, v.local, v.kind === 'other' ? null : v.kind, v.category, JSON.stringify(v.audiences ?? []), v.urgent ?? null, keep ? 'new' : 'skipped', r.id);
      });
    }
    // duplicates whose story got its verdict in this round
    raw.prepare(`UPDATE channel_items AS i SET score = s.score, local = s.local, kind = s.kind, category = s.category, audiences = s.audiences, status = s.status
      FROM channel_items AS s WHERE i.desk_id = ? AND i.score IS NULL AND s.id = i.story_id AND s.score IS NOT NULL`).run(d.id);
  }

  // Jev knows the city but not every town of its suburbs (a festival in Picassent is «elsewhere»): items it is unsure
  // about go to a model that knows the map; an answer it cannot give leaves Jev's verdict
  async function checkPlaces(d: ChannelDesk, rows: Row[], verdicts: Awaited<ReturnType<ChannelsDeps['score']>>) {
    const doubt = verdicts.map((v, i) => ({ v, i })).filter(({ v }) => v.kind !== 'other' && v.local !== null && v.local >= PLACE_DOUBT[0] && v.local < PLACE_DOUBT[1]);
    if (!doubt.length || !d.area) return;
    const found = await deps.llm([
      'Для каждого материала определи, где это происходит (город, район, площадка), и входит ли это место в географию канала.',
      'Пригороды и районы проверяй по своим знаниям карты: какому муниципалитету и комарке принадлежит место. Решение или услуга для жителей этих мест — тоже «да».',
      `География канала: ${d.area}`,
      'Ответ — только JSON: {"<номер>": {"place": "…", "inside": true|false}}. Место не понять — не включай номер.',
      '',
      ...doubt.map(({ i }) => `<item n="${i + 1}">\n${rows[i].title}\n${String(rows[i].text).slice(0, 900)}\n</item>`),
    ].join('\n'), { json: true, role: 'fast', title: 'channel-place-check' }).then((r) => parseJsonFromLlm(r) as Record<string, { inside?: unknown }>).catch(() => ({} as Record<string, { inside?: unknown }>));
    for (const { v, i } of doubt) {
      const inside = found[String(i + 1)]?.inside;
      if (typeof inside === 'boolean') v.local = inside ? 0.9 : 0.1;
    }
  }

  // ---- posts ----

  const inCategories = (category: string | null, wanted: string[]) =>
    !wanted.length || (!!category && wanted.some((w) => category === w || category.startsWith(`${w}.`)));

  // The best fresh stories that fit: by the slot's rubrics, or by kind; a story told by more sources ranks higher
  function pickStories(d: ChannelDesk, kind: ChannelSlotKind, categories: string[] = [], audiences: string[] = []): number[] {
    const kinds = categories.length || audiences.length ? ['news', 'deal', 'event'] : kind === 'deals' ? ['deal', 'event'] : kind === 'top' ? ['news'] : ['news', 'event', 'deal'];
    const rows = raw.prepare(`SELECT story_id, MAX(score) AS score, COUNT(DISTINCT source_id) AS sources, MAX(published_at) AS at,
        -- the story's verdict is its head's: items scored before stories existed may disagree
        COALESCE(MAX(CASE WHEN id = story_id THEN kind END), MAX(kind)) AS kind,
        COALESCE(MAX(CASE WHEN id = story_id THEN category END), MAX(category)) AS category,
        COALESCE(MAX(CASE WHEN id = story_id THEN audiences END), MAX(audiences)) AS audiences
      FROM channel_items WHERE desk_id = ? AND story_id IS NOT NULL
      GROUP BY story_id
      -- alive (its latest telling is fresh), not used, fits; importance counts every outlet that told it, old or new
      HAVING MAX(published_at) >= ? AND MAX(score) >= ? AND SUM(CASE WHEN status <> 'new' THEN 1 ELSE 0 END) = 0`).all(d.id, now() - FRESH_MS, d.threshold) as Row[];
    const ranked = rows
      .filter((r) => kinds.includes(r.kind))
      .filter((r) => inCategories(r.category, categories))
      .filter((r) => !audiences.length || (JSON.parse(r.audiences || '[]') as string[]).some((a) => audiences.includes(a)))
      .map((r) => ({ id: r.story_id as number, kind: r.kind as string, rank: r.score + 0.06 * Math.min(r.sources - 1, 5) /* told by many outlets — a big story */, at: r.at as number }))
      .sort((a, b) => b.rank - a.rank || b.at - a.at);
    // a full digest: half city news, half the listings (events, plans, deals); one side short — the other fills in
    if (kind === 'digest' && !categories.length && !audiences.length) {
      const half = POST_ITEMS.digest / 2;
      const news = ranked.filter((r) => r.kind === 'news');
      const listings = ranked.filter((r) => r.kind !== 'news');
      const take = [...news.slice(0, Math.max(half, POST_ITEMS.digest - listings.length)), ...listings.slice(0, Math.max(half, POST_ITEMS.digest - news.length))];
      return take.slice(0, POST_ITEMS.digest).map((r) => r.id);
    }
    return ranked.slice(0, POST_ITEMS[kind]).map((r) => r.id);
  }

  // Urgent for residents (a metro line stopped, a weather warning, a closure): out at once as a short post, not waiting
  // for the evening issue; a few a day, never at night
  async function sendAlerts(d: ChannelDesk) {
    if (!d.alerts) return;
    const t = now();
    const h = new Date(t).getHours();
    if (h < 7 || h >= 23) return;
    const today = new Date(t);
    const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
    let sent = (raw.prepare("SELECT COUNT(*) AS n FROM channel_posts WHERE desk_id = ? AND kind = 'alert' AND created_at >= ?").get(d.id, dayStart) as Row).n as number;
    const urgent = raw.prepare(`SELECT DISTINCT COALESCE(story_id, id) AS sid FROM channel_items WHERE desk_id = ? AND status = 'new' AND urgent >= ?
      AND score >= ? AND (local IS NULL OR local >= 0.5) AND published_at >= ? ORDER BY urgent DESC`).all(d.id, ALERT_SCORE, d.threshold, t - ALERT_FRESH_MS) as Row[];
    for (const u of urgent) {
      if (sent >= ALERTS_PER_DAY) return;
      try {
        const p = await compose(d.id, 'alert', [u.sid]);
        sent++;
        if (d.autopublish) await publish(p.id);
      } catch (err) {
        console.warn(`channel «${d.title}» alert:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // The editor writes an issue as data, not as text: the layout is the code's, so every issue reads the same way —
  // a title, a lead, sections, and items with what / when / where / price and a map link
  async function writeIssue(d: ChannelDesk, kind: ChannelSlotKind, stories: ChannelItem[][], o: { rubrics: string[]; forWhom: (string | undefined)[]; own: boolean }): Promise<Issue> {
    const what = kind === 'digest'
      ? 'полный выпуск: раздел новостей города и раздел мероприятий (события, планы, акции); названия разделов — на языке поста, коротко, с эмодзи'
      : kind === 'deals' ? 'подборку акций, планов и событий: разделы по смыслу (например, «сегодня и завтра», «на выходные», «скидки»)'
        : kind === 'alert' ? 'срочное сообщение: заголовок выпуска — «⚠️» и суть в нескольких словах, без вступления, один раздел без названия, один пункт: что случилось, где, до какого времени и что делать читателю (обход, замена, как себя вести)'
          : 'один главный сюжет подробно: заголовок выпуска — о самом сюжете, один раздел, один пункт, текст 3–5 предложений со всеми практическими деталями из материалов';
    const schema = `{"title": "заголовок выпуска: название канала, день и дата", "lead": "1–2 предложения: главное за день и почему стоит дочитать", "sections": [{"title": "🎭 название раздела", "items": [{"story": "номер сюжета из материалов (n)", "emoji": "🎶", "title": "что это, конкретно", "text": "одно-два коротких предложения, до 220 знаков: суть и что это значит для читателя", "when": "день, дата и время, если есть", "where": "конкретное место так, как его ищут на картах: заведение или адрес и город (например «Recinto Ágora, Torrent»); для новостей без конкретного места — пусто", "price": "цена, «gratis» или условия входа, если есть", "places": [{"name": "место", "where": "как искать на картах: название и город"}] — если в материалах названо несколько конкретных мест одного сюжета (здания дня открытых дверей, заведения акции, точки маршрута), перечисли ВСЕ названные, иначе [], "placesTitle": "подпись свёрнутого списка на языке поста с эмодзи, например «📍 Ver los 12 edificios en el mapa»", "tags": ["0–2 метки: эмодзи и слово, ПЕРЕВЕДЁННЫЕ на язык поста, только из смыслов free / with kids / family / tonight / this weekend / today / last day (например, по-испански «🆓 gratis», «👧 con niños», «📅 este finde», «⏳ último día»); тематических меток не ставь"]${o.own ? '' : ', "source": "url источника"'}}]}], "footer": "подпись канала по правилам редактора, если есть"}`;
    const prompt = [
      `Ты — редактор Telegram-канала. О канале и аудитории: ${d.about || '—'}.`,
      d.area ? `География канала: ${d.area}. Пиши только о том, что происходит там; что за её пределами — пропусти.` : '',
      `Собери ${what}${o.rubrics.length ? ` — рубрики: ${o.rubrics.join(', ')}` : ''}${o.forWhom.length ? ` — для аудитории: ${o.forWhom.join(', ')}; подавай под неё` : ''}. Язык всех текстов — ${d.language}, даже если материалы на другом.`,
      // the editor's rules may differ by post kind and time of day («good morning» only in the morning)
      `Вид поста: ${kind} — «${CHANNEL_SLOT_KINDS[kind]}». Сейчас ${partOfDay(now())} — ${new Date(now()).toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}. Из правил редактора применяй только те, что подходят этому виду поста и времени суток (утреннее приветствие — только утром).`,
      d.editorPrompt || DEFAULT_EDITOR,
      o.own ? OWN_STORIES : 'У каждого пункта — url источника в поле source.',
      'Польза читателю важнее пересказа: в каждом пункте — что это значит для него (что изменится, что успеть, куда сходить, сколько сэкономить); сроки и «последний день» — явно. Без воды и общих слов.',
      'Один сюжет может прийти из нескольких источников: собери из них один пункт с самыми точными данными; если источники расходятся — бери то, в чём они сходятся, или не указывай деталь.',
      'Факты, цифры, даты, места и цены — только из материалов; чего в них нет, оставь поле пустым. Не упоминай, что пишешь по материалам. Никакой разметки внутри полей.',
      `Ответ — только JSON: ${schema}`,
      '',
      ...stories.map((st, i) => [
        `<story n="${i + 1}" kind="${st[0].kind}" rubric="${channelCategoryName(d.categories, st[0].category)}">`,
        ...st.map((it) => `<source${o.own ? '' : ` url="${it.url ?? ''}"`} date="${new Date(it.publishedAt).toISOString().slice(0, 16)}">\n${it.title}\n${it.text.slice(0, kind === 'top' ? 3000 : 1200)}\n</source>`),
        '</story>',
      ].join('\n')),
    ].filter((x) => x !== '').join('\n');
    const draft = parseIssue(await deps.llm(prompt, { json: true, role: 'chat', title: 'channel-post' }));
    if (!draft.sections.some((sec) => sec.items.length)) throw new Error('Редактор вернул пустой выпуск');
    // the proofreader: another model checks every field against the materials — what they do not say goes, what
    // contradicts them is fixed; the editor's wording stays
    const materials = stories.map((st, i) => `<story n="${i + 1}">\n${st.map((it) => `${it.title}\n${it.text.slice(0, kind === 'top' ? 3000 : 1200)}`).join('\n---\n')}\n</story>`).join('\n');
    // the proofreader returns fixes, not a rewritten issue: rewriting, a model drops sections and the channel's footer
    const numbered = { title: draft.title, lead: draft.lead, sections: draft.sections.map((sec, si) => ({ section: si, title: sec.title, items: sec.items.map((it, ii) => ({ item: ii, ...it })) })) };
    const fixes = await deps.llm([
      'Ты — корректор и фактчекер Telegram-канала. Сверь каждый пункт выпуска с материалами, по которым он написан.',
      '- Каждый факт — дата, время, место, цена, «бесплатно», имена, цифры, метки — должен прямо следовать из материалов. Противоречит — исправь по материалам; нет в материалах — убери (пустая строка; для меток — список без неё).',
      '- Убери выдуманные украшения и советы, которых нет в материалах («места разлетаются», «бронируйте заранее» и т. п.).',
      '- Заголовок пункта и метки не должны обещать то, чего нет (например, «бесплатно», если вход платный).',
      '- Сохраняй язык и стиль; правь только то, что неверно. Пункт целиком выдуман или не о том — удали его.',
      'Заголовок и вступление выпуска проверь так же.',
      'Ответ — только JSON: {"fixes": [{"section": 0, "item": 1, "field": "title|text|when|where|price|tags|places", "value": "новое значение (для tags и places — массив)"}, {"field": "lead|issueTitle", "value": "…"}], "drop": [{"section": 0, "item": 2}]}. Всё верно — {"fixes": [], "drop": []}.',
      '',
      `<issue>\n${JSON.stringify(numbered)}\n</issue>`,
      '',
      `<materials>\n${materials}\n</materials>`,
    ].join('\n'), { json: true, role: 'smart', title: 'channel-factcheck' }).then((r) => parseJsonFromLlm(r) as { fixes?: unknown[]; drop?: unknown[] }).catch((err) => {
      console.warn('channel factcheck', err instanceof Error ? err.message : err);
      return { fixes: [], drop: [] }; // the editor's issue is still an issue
    });
    const issue = await enrichListings(d, await addPlaces(d, applyFixes(draft, fixes), stories, kind), stories);
    // nothing leads out of the channel: links, addresses and other channels' names go from every field
    return o.own ? mapIssue(issue, (t) => stripLinks(t, d.username)) : issue;
  }

  // Several venues of one story (an open-house weekend, a route, a chain's offer) go into a folded list with map links.
  // A separate small step: an editor busy with the whole issue skips the list even when the places are named.
  async function addPlaces(d: ChannelDesk, issue: Issue, stories: ChannelItem[][], kind: ChannelSlotKind): Promise<Issue> {
    const wanted = issue.sections.flatMap((sec) => sec.items).filter((it) => it.places.length < 3 && it.story && stories[it.story - 1]);
    if (!wanted.length) return issue;
    const ns = [...new Set(wanted.map((it) => it.story!))];
    const found = await deps.llm([
      'Для каждого сюжета перечисли конкретные места, которые прямо названы в его материалах: здания, заведения, площадки, магазины, точки маршрута.',
      'Только если их три и больше; не придумывай и не добавляй неназванные. «where» — как искать место на картах: название и город (город — из материалов или географии канала).',
      `География канала: ${d.area || d.about.slice(0, 200)}. Язык подписи — ${d.language}.`,
      'Ответ — только JSON: {"<номер сюжета>": {"title": "подпись свёрнутого списка с эмодзи, например «📍 Ver los 12 edificios en el mapa»", "places": [{"name": "…", "where": "…"}]}}. Нет мест — {}.',
      '',
      ...ns.map((n) => `<story n="${n}">\n${stories[n - 1].map((it) => `${it.title}\n${it.text.slice(0, kind === 'top' ? 3000 : 1500)}`).join('\n---\n')}\n</story>`),
    ].join('\n'), { json: true, role: 'fast', title: 'channel-places' }).then((r) => parseJsonFromLlm(r) as Record<string, { title?: unknown; places?: unknown[] }>).catch(() => ({} as Record<string, { title?: unknown; places?: unknown[] }>));
    return {
      ...issue,
      sections: issue.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => {
        const f = it.places.length < 3 && it.story ? found[String(it.story)] : undefined;
        const places = (Array.isArray(f?.places) ? f!.places : []).map((p: any) => ({ name: str(p?.name), where: str(p?.where) || str(p?.name) })).filter((p) => p.name).slice(0, 25);
        return places.length >= 3 ? { ...it, places, placesTitle: str(f?.title) || it.placesTitle } : it;
      }) })),
    };
  }

  // The listings' researcher: for events and offers it looks the place up on the web — the exact address, opening hours,
  // the price — and fills what the materials left vague, only when the page is clearly about this very event or place.
  // (After the proofreader: these facts come from the web, not from the materials.)
  async function enrichListings(d: ChannelDesk, issue: Issue, stories: ChannelItem[][]): Promise<Issue> {
    if (!deps.search) return issue;
    const city = (d.area.split(/[(,—–-]/)[0] || d.area).trim().slice(0, 60);
    const vague = (it: IssueItem) => !/\d/.test(it.where) || !it.price || !it.when;
    const targets = issue.sections.flatMap((sec) => sec.items)
      .filter((it) => it.story && stories[it.story - 1] && stories[it.story - 1][0].kind !== 'news' && vague(it))
      .slice(0, ENRICH_ITEMS);
    const found = new Map<IssueItem, { where?: string; when?: string; price?: string }>();
    await Promise.all(targets.map(async (it) => {
      try {
        const results = (await deps.search!(`${it.title} ${it.where} ${city}`.replace(/\s+/g, ' ').trim())).slice(0, 4);
        if (!results.length) return;
        const page = await fetchText(await finalUrl(results[0].url)).then((r) => articleText(r.body).slice(0, 2500), () => '');
        const web = [...results.map((r) => `### ${r.title}\n${r.content.slice(0, 900)}`), page && `### ${results[0].title} (страница)\n${page}`].filter(Boolean).join('\n\n');
        const r = parseJsonFromLlm(await deps.llm([
          'Пункт афиши Telegram-канала и найденное о нём в интернете. Уточни пункт, но только тем, что в найденном прямо сказано о ЭТОМ же событии или месте (то же название, те же даты, тот же город).',
          `- where: точный адрес места — название, улица и номер, город (${city}), как ищут на картах; не нашёл точнее — пусто.`,
          '- when: даты и часы, если в пункте их нет или они неполные; иначе пусто.',
          '- price: цена или условия входа, если в пункте их нет; иначе пусто.',
          `Пиши на языке пункта (${d.language}). Сомневаешься, то ли это событие, — всё пусто. Ответ — только JSON: {"where": "", "when": "", "price": ""}.`,
          '',
          `<item>\n${JSON.stringify({ title: it.title, text: it.text, when: it.when, where: it.where, price: it.price })}\n</item>`,
          '',
          `<web>\n${web}\n</web>`,
        ].join('\n'), { json: true, role: 'fast', title: 'channel-enrich' })) as Record<string, unknown>;
        found.set(it, { where: str(r.where), when: str(r.when), price: str(r.price) });
      } catch (err) {
        console.warn('channel enrich', err instanceof Error ? err.message : err);
      }
    }));
    if (!found.size) return issue;
    return {
      ...issue,
      sections: issue.sections.map((sec) => ({ ...sec, items: sec.items.map((it) => {
        const f = found.get(it);
        if (!f) return it;
        return {
          ...it,
          where: f.where && /\d/.test(f.where) && !/\d/.test(it.where) ? f.where : it.where, // only a more precise address
          when: it.when || f.when || '',
          price: it.price || f.price || '',
        };
      }) })),
    };
  }

  // The cover: a meta-prompt turns the issue into a Muse Image prompt (scene → setting → light → framing → style →
  // the only literal text), then the poster is drawn
  async function drawCover(d: ChannelDesk, issue: Issue): Promise<string | null> {
    if (!deps.cover) return null;
    const stories = issue.sections.flatMap((sec) => sec.items).slice(0, 5).map((it) => `- ${it.title}${it.where ? ` (${it.where})` : ''}${it.when ? ` — ${it.when}` : ''}`).join('\n');
    const date = new Date(now()).toLocaleDateString(/espa/i.test(d.language) ? 'es-ES' : /engl/i.test(d.language) ? 'en-GB' : 'ru-RU', { day: 'numeric', month: 'short' }).replace('.', '').toUpperCase();
    const masthead = (d.title.split(/[^\p{L}\p{N} ]/u)[0] || d.title).trim().toUpperCase();
    const prompt = (await deps.llm([
      'You write one prompt for the Muse Image model (Meta): the cover of a Telegram channel issue, a poster of the city\'s day.',
      'Order: subject and action → setting → light → framing and composition → style and palette → the only literal text. Coherent prose, 90–150 words, English. No lists, no quality tags, no negative-prompt syntax.',
      'Show 3–4 of the stories below as concrete, recognisable visual vignettes (objects, places, activities — e.g. a stage with lights, market stalls, boats at a marina), arranged in one poster composition around the city\'s landmark or street life. No real people\'s faces, no logos, no brand names, no maps, no screenshots.',
      `Literal text, exactly and nothing else: the title "${masthead}" large at the top and "${date}" small below it, in clean bold sans-serif; leave generous margins. Every other surface carries no readable text.`,
      `Style: ${d.coverStyle || 'warm flat editorial illustration with subtle paper grain, limited palette, clear shapes readable at small size'}.`,
      `Channel: ${d.about.slice(0, 300)}`,
      '',
      'Stories of this issue:',
      stories,
      '',
      'Answer with the prompt only.',
    ].join('\n'), { role: 'chat', title: 'channel-cover-prompt' })).trim().replace(/^"|"$/g, '');
    if (!prompt) return null;
    return deps.cover(prompt, d.id);
  }

  async function compose(deskId: number, kind: ChannelSlotKind, itemIds?: number[],
    opts: { categories?: string[]; audiences?: string[]; slotKey?: string; scheduledAt?: number } = {}): Promise<ChannelPost> {
    const d = desk(deskId);
    const categories = opts.categories ?? [];
    const audiences = opts.audiences ?? [];
    const storyIds = itemIds?.length
      ? [...new Set((raw.prepare(`SELECT COALESCE(story_id, id) AS s FROM channel_items WHERE id IN (${itemIds.map(() => '?').join(',')})`).all(...itemIds) as Row[]).map((r) => r.s as number))]
      : pickStories(d, kind, categories, audiences);
    if (!storyIds.length) throw new Error('Нет свежих подходящих материалов для поста');
    // every source's telling of each story: the editor writes one story from all of them
    const stories = storyIds.map((sid) => (raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i JOIN channel_sources s ON s.id = i.source_id
      WHERE COALESCE(i.story_id, i.id) = ? ORDER BY i.score DESC, i.id LIMIT ?`).all(sid, kind === 'top' ? 6 : 4) as Row[]).map(toItem)).filter((x) => x.length);
    const items = stories.flat();
    const own = d.links === 'none';
    const rubrics = categories.map((c) => channelCategoryName(d.categories, c)).filter(Boolean);
    const forWhom = audiences.map((a) => d.audiences.find((x) => x.id === a)?.name).filter(Boolean);
    const issue = await writeIssue(d, kind, stories, { rubrics, forWhom, own });
    const text = renderIssue(issue, { own, username: d.username });
    if (!text.trim()) throw new Error('Редактор вернул пустой пост');
    // the cover: drawn for this issue; without it — a source photo only when the channel links its sources
    const image = (d.cover && kind !== 'alert' ? await drawCover(d, issue).catch((err) => (console.warn('channel cover', err instanceof Error ? err.message : err), null)) : null)
      ?? (own ? null : items.find((it) => it.image)?.image ?? null);
    const id = Number(raw.prepare('INSERT INTO channel_posts(desk_id, kind, text, image, item_ids, slot_key, scheduled_at, issue, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(d.id, kind, text, image, JSON.stringify(items.map((i) => i.id)), opts.slotKey ?? null, opts.scheduledAt ?? null, JSON.stringify(issue), now()).lastInsertRowid);
    raw.prepare(`UPDATE channel_items SET status = 'used' WHERE COALESCE(story_id, id) IN (${storyIds.map(() => '?').join(',')})`).run(...storyIds);
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

  // Posts and sources run apart: a long first read of many sources must never make a post late
  let posting = false;
  async function postsTick() {
    if (posting) return;
    posting = true;
    try {
      const t = now();
      for (const d of listDesks().filter((x) => x.enabled)) {
        // drafts scheduled by the owner (or prepared for a slot): published when their time comes
        for (const p of raw.prepare("SELECT id FROM channel_posts WHERE desk_id = ? AND status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= ?").all(d.id, t) as Row[]) {
          await publish(p.id);
        }
        // slots: today's time has come, not done yet, and not more than an hour late
        const today = new Date(t);
        for (const slot of d.slots) {
          if (slot.days?.length && !slot.days.includes(today.getDay())) continue;
          const key = `${dayKey(today)} ${slot.time}`;
          const at = slotTime(key);
          if (t < at || t - at > LATE_SLOT_MS) continue;
          if (raw.prepare('SELECT 1 FROM channel_slot_runs WHERE desk_id = ? AND slot_key = ?').get(d.id, key)) continue;
          // prepared in advance: that post is the slot's (published above at its time)
          const prepared = raw.prepare("SELECT id FROM channel_posts WHERE desk_id = ? AND slot_key = ? AND status IN ('draft', 'published') ORDER BY id DESC").get(d.id, key) as Row | undefined;
          raw.prepare('INSERT INTO channel_slot_runs(desk_id, slot_key, post_id) VALUES(?, ?, ?)').run(d.id, key, prepared?.id ?? null);
          if (prepared) continue;
          try {
            const p = await compose(d.id, slot.kind, undefined, { categories: slot.categories, audiences: slot.audiences, slotKey: key });
            raw.prepare('UPDATE channel_slot_runs SET post_id = ? WHERE desk_id = ? AND slot_key = ?').run(p.id, d.id, key);
            if (d.autopublish) await publish(p.id);
          } catch (err) {
            console.warn(`channel «${d.title}» slot ${slot.time}:`, err instanceof Error ? err.message : err);
          }
        }
      }
    } finally {
      posting = false;
    }
  }

  let reading = false;
  async function sourcesTick() {
    if (reading) return;
    reading = true;
    try {
      for (const d of listDesks().filter((x) => x.enabled)) {
        // the sources that are due, one at a time (gentle on sites and on the Telegram account)
        for (const s of raw.prepare('SELECT * FROM channel_sources WHERE desk_id = ? AND enabled = 1').all(d.id) as Row[]) {
          if (!s.last_run_at || now() - s.last_run_at >= s.interval_min * 60_000) await runSource(s.id);
        }
      }
    } finally {
      reading = false;
    }
  }

  async function tick() {
    await postsTick();
    await sourcesTick();
  }

  let timer: ReturnType<typeof setInterval> | null = null;

  return {
    start() {
      timer = setInterval(() => {
        void postsTick().catch((err) => console.error('channels posts', err));
        void sourcesTick().catch((err) => console.error('channels sources', err));
      }, TICK_MS);
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
      raw.prepare(`UPDATE channel_desks SET enabled = ?, account_id = ?, language = ?, about = ?, editor_prompt = ?, slots = ?, autopublish = ?, threshold = ?,
        area = ?, links = ?, categories = ?, audiences = ?, cover = ?, cover_style = ?, alerts = ? WHERE id = ?`).run(d.enabled ? 1 : 0, d.accountId, d.language, d.about, d.editorPrompt, JSON.stringify(d.slots),
        d.autopublish ? 1 : 0, d.threshold, d.area ?? '', d.links === 'sources' ? 'sources' : 'none', JSON.stringify(d.categories ?? DEFAULT_CHANNEL_CATEGORIES),
        JSON.stringify(d.audiences ?? DEFAULT_CHANNEL_AUDIENCES), d.cover === false ? 0 : 1, d.coverStyle ?? '', d.alerts ? 1 : 0, d.id);
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
    setStoryStatus(storyId: number, status: ChannelItem['status']) {
      raw.prepare('UPDATE channel_items SET status = ? WHERE COALESCE(story_id, id) = ?').run(status, storyId);
    },
    // Stories with every source that told them, newest first
    stories(deskId: number, status: ChannelItem['status'], limit = 100): ChannelStory[] {
      const heads = raw.prepare(`SELECT COALESCE(story_id, id) AS sid, MAX(published_at) AS at FROM channel_items
        WHERE desk_id = ? AND status = ? AND score IS NOT NULL GROUP BY sid ORDER BY at DESC LIMIT ?`).all(deskId, status, limit) as Row[];
      return heads.map((h) => {
        const items = (raw.prepare(`SELECT i.*, s.title AS source_title FROM channel_items i LEFT JOIN channel_sources s ON s.id = i.source_id
          WHERE COALESCE(i.story_id, i.id) = ? ORDER BY i.id`).all(h.sid) as Row[]).map(toItem);
        const head = items.find((i) => i.id === h.sid) ?? items[0];
        return {
          id: h.sid, title: head.title, text: head.text, kind: head.kind, category: head.category, score: head.score, local: head.local, audiences: head.audiences,
          status: head.status, publishedAt: h.at,
          items: items.map((i) => ({ id: i.id, sourceTitle: i.sourceTitle, title: i.title, url: i.url, publishedAt: i.publishedAt })),
        };
      });
    },
    // How much each source brings: items, stories it found first, repeats of stories already found, what fits
    feedStats(deskId: number, days = 1): ChannelFeedStats {
      const since = now() - days * 86400_000;
      const t = raw.prepare(`SELECT COUNT(*) AS items, COUNT(DISTINCT COALESCE(story_id, id)) AS stories,
          SUM(CASE WHEN story_id IS NOT NULL AND story_id <> id THEN 1 ELSE 0 END) AS dups,
          COUNT(DISTINCT CASE WHEN status <> 'skipped' AND score IS NOT NULL THEN COALESCE(story_id, id) END) AS kept
        FROM channel_items WHERE desk_id = ? AND created_at >= ?`).get(deskId, since) as Row;
      const byAudience: Record<string, number> = {};
      for (const r of raw.prepare(`SELECT COALESCE(story_id, id) AS sid, MAX(audiences) AS audiences FROM channel_items
        WHERE desk_id = ? AND status = 'new' AND score IS NOT NULL AND published_at >= ? GROUP BY sid`).all(deskId, now() - FRESH_MS) as Row[]) {
        for (const a of JSON.parse(r.audiences || '[]') as string[]) byAudience[a] = (byAudience[a] ?? 0) + 1;
      }
      const cats = raw.prepare(`SELECT category, COUNT(DISTINCT COALESCE(story_id, id)) AS n FROM channel_items
        WHERE desk_id = ? AND status = 'new' AND score IS NOT NULL AND published_at >= ? GROUP BY category`).all(deskId, now() - FRESH_MS) as Row[];
      const sources = raw.prepare(`SELECT s.id, s.title, s.kind, COUNT(i.id) AS items,
          SUM(CASE WHEN i.story_id = i.id OR i.story_id IS NULL THEN 1 ELSE 0 END) AS first,
          SUM(CASE WHEN i.story_id IS NOT NULL AND i.story_id <> i.id THEN 1 ELSE 0 END) AS dups,
          SUM(CASE WHEN i.status <> 'skipped' AND i.score IS NOT NULL THEN 1 ELSE 0 END) AS kept
        FROM channel_sources s LEFT JOIN channel_items i ON i.source_id = s.id AND i.created_at >= ?
        WHERE s.desk_id = ? GROUP BY s.id ORDER BY items DESC`).all(since, deskId) as Row[];
      return {
        items: t.items ?? 0, stories: t.stories ?? 0, duplicates: t.dups ?? 0, kept: t.kept ?? 0,
        byCategory: Object.fromEntries(cats.map((c) => [c.category ?? '', c.n])),
        byAudience,
        sources: sources.map((r) => ({ sourceId: r.id, title: r.title, kind: r.kind, items: r.items, first: r.first ?? 0, duplicates: r.dups ?? 0, kept: r.kept ?? 0 })),
      };
    },
    // After changing the rubrics, the area or the description: fresh unposted items are grouped and scored again
    async rescore(deskId: number): Promise<number> {
      const d = desk(deskId);
      const n = Number(raw.prepare(`UPDATE channel_items SET score = NULL, local = NULL, kind = NULL, category = NULL, story_id = NULL, status = 'new'
        WHERE desk_id = ? AND published_at >= ? AND status <> 'used'`).run(deskId, now() - STORY_WINDOW_MS).changes);
      await assignStories(d);
      await scorePending(d);
      return n;
    },
    posts(deskId: number, limit = 30): ChannelPost[] {
      return (raw.prepare('SELECT * FROM channel_posts WHERE desk_id = ? ORDER BY id DESC LIMIT ?').all(deskId, limit) as Row[]).map(toPost);
    },
    compose,
    schedule(id: number, at: number | null): ChannelPost {
      raw.prepare("UPDATE channel_posts SET scheduled_at = ? WHERE id = ? AND status = 'draft'").run(at, id);
      return post(id);
    },
    // Days around today: every slot with its post (or what it would be made of), plus posts outside the schedule
    calendar(deskId: number, fromDays = -2, toDays = 6): ChannelCalendarEntry[] {
      const d = desk(deskId);
      const t = now();
      const base = new Date(t);
      const out: ChannelCalendarEntry[] = [];
      const seen = new Set<number>();
      const state = (p: ChannelPost): ChannelCalendarEntry['state'] =>
        p.status === 'draft' ? (p.scheduledAt ? 'scheduled' : 'draft') : p.status;
      for (let day = fromDays; day <= toDays; day++) {
        const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + day);
        for (const slot of d.slots) {
          if (slot.days?.length && !slot.days.includes(date.getDay())) continue;
          const key = `${dayKey(date)} ${slot.time}`;
          const at = slotTime(key);
          const run = raw.prepare('SELECT post_id FROM channel_slot_runs WHERE desk_id = ? AND slot_key = ?').get(d.id, key) as Row | undefined;
          const row = (run?.post_id ? raw.prepare('SELECT * FROM channel_posts WHERE id = ?').get(run.post_id)
            : raw.prepare("SELECT * FROM channel_posts WHERE desk_id = ? AND slot_key = ? AND status <> 'rejected' ORDER BY id DESC").get(d.id, key)) as Row | undefined;
          const p = row ? toPost(row) : null;
          if (p) seen.add(p.id);
          const st: ChannelCalendarEntry['state'] = p ? state(p) : run || at < t - LATE_SLOT_MS ? 'missed' : 'planned';
          out.push({
            at, slot, slotKey: key, post: p, state: st,
            ready: st === 'planned' && at - t < 36 * 3600_000 ? pickStories(d, slot.kind, slot.categories, slot.audiences).length : null,
          });
        }
      }
      const from = new Date(base.getFullYear(), base.getMonth(), base.getDate() + fromDays).getTime();
      const to = new Date(base.getFullYear(), base.getMonth(), base.getDate() + toDays + 1).getTime();
      for (const r of raw.prepare("SELECT * FROM channel_posts WHERE desk_id = ? AND status <> 'rejected' AND COALESCE(published_at, scheduled_at, created_at) BETWEEN ? AND ?").all(d.id, from, to) as Row[]) {
        const p = toPost(r);
        if (seen.has(p.id)) continue;
        out.push({ at: p.publishedAt ?? p.scheduledAt ?? p.createdAt, slot: null, slotKey: p.slotKey, post: p, state: state(p), ready: null });
      }
      return out.sort((a, b) => a.at - b.at);
    },
    savePost(id: number, text: string): ChannelPost {
      raw.prepare("UPDATE channel_posts SET text = ? WHERE id = ? AND status <> 'published'").run(text, id);
      return post(id);
    },
    publish,
    // A published post taken down: deleted from the channel, its stories back in work (e.g. to be told again better)
    async unpublish(id: number): Promise<ChannelPost> {
      const p = post(id);
      if (p.status !== 'published' || !p.messageId) throw new Error('Пост не опубликован');
      const d = desk(p.deskId);
      await deps.engine.deleteMessages(d.accountId, d.chatId, [p.messageId]);
      raw.prepare("UPDATE channel_posts SET status = 'rejected', error = 'удалён из канала' WHERE id = ?").run(id);
      if (p.itemIds.length) {
        raw.prepare(`UPDATE channel_items SET status = 'new' WHERE status = 'used' AND COALESCE(story_id, id) IN
          (SELECT COALESCE(story_id, id) FROM channel_items WHERE id IN (${p.itemIds.map(() => '?').join(',')}))`).run(...p.itemIds);
      }
      return post(id);
    },
    async cloneForCity(fromDeskId: number, accountId: number, city: string, target: { link: string } | { title: string; description: string; username?: string }) {
      const from = desk(fromDeskId);
      if (!city.trim()) throw new Error('Укажите город');
      const plan = parseJsonFromLlm(await deps.llm([
        `Есть Telegram-канал городских новостей. Сделай такой же для города: ${city}. Перепиши его настройки под этот город, сохранив смысл, формат и тон.`,
        'Язык постов — главный язык жителей этого города (как у исходного канала — язык жителей своего города). Тексты about, area, coverStyle и подсказки — по-английски, editorPrompt — на языке постов.',
        'feeds — RSS-ленты местных СМИ, мэрии, транспорта, метеослужбы и афиш этого города, которые ты точно знаешь; pages — страницы новостей мэрии и городских служб без RSS. Не выдумывай адреса: всё будет проверено, неработающее отбросится.',
        'queries — 6–10 запросов для Google Новостей (kind "gnews") и поиска (kind "search") по образцу исходных, но для этого города и его пригородов.',
        'Ответ — только JSON: {"language": "…", "about": "…", "area": "…", "editorPrompt": "…", "coverStyle": "…", "queries": [{"kind": "gnews|search", "title": "…", "target": "…"}], "feeds": [{"title": "…", "url": "…"}], "pages": [{"title": "…", "url": "…"}]}',
        '',
        `<source_channel language="${from.language}">`,
        `about: ${from.about}`,
        `area: ${from.area}`,
        `editorPrompt: ${from.editorPrompt}`,
        `coverStyle: ${from.coverStyle}`,
        `queries: ${JSON.stringify(listSources(from.id).filter((x) => x.kind === 'gnews' || x.kind === 'search').map((x) => ({ kind: x.kind, title: x.title, target: x.target })))}`,
        '</source_channel>',
      ].join('\n'), { json: true, role: 'smart', title: 'channel-clone' })) as Record<string, any>;
      const chat = 'link' in target ? await deps.engine.resolveChat(accountId, target.link.trim()) : await deps.engine.createChannel(accountId, target);
      if (chat.kind !== 'channel') throw new Error('Нужен канал: помощник публикует посты в канал');
      const d = addDesk(accountId, chat);
      // the channel's own @name in the editor's rules instead of the source channel's
      const editorPrompt = String(plan.editorPrompt || from.editorPrompt).replaceAll(`@${from.username ?? '\u0000'}`, chat.username ? `@${chat.username}` : '');
      raw.prepare(`UPDATE channel_desks SET language = ?, about = ?, area = ?, editor_prompt = ?, cover_style = ?, slots = ?, threshold = ?, links = ?,
        categories = ?, audiences = ?, cover = ?, alerts = ?, autopublish = 0 WHERE id = ?`).run(
        String(plan.language || from.language), String(plan.about || ''), String(plan.area || city), editorPrompt, String(plan.coverStyle || from.coverStyle),
        JSON.stringify(from.slots), from.threshold, from.links, JSON.stringify(from.categories), JSON.stringify(from.audiences), from.cover ? 1 : 0, from.alerts ? 1 : 0, d.id);
      // proposed sources are kept only when they answer: a feed with items, a page with text
      const rejected: string[] = [];
      const add = (kind: ChannelSource['kind'], title: string, target: string) =>
        raw.prepare('INSERT INTO channel_sources(desk_id, kind, title, target, enabled, interval_min, created_at) VALUES(?, ?, ?, ?, 1, ?, ?)')
          .run(d.id, kind, title || target, target, CHANNEL_SOURCE_KINDS[kind].interval, now());
      for (const q of Array.isArray(plan.queries) ? plan.queries : []) {
        if ((q?.kind === 'gnews' || q?.kind === 'search') && String(q.target ?? '').trim()) add(q.kind, String(q.title ?? ''), String(q.target).trim());
      }
      await Promise.all([
        ...(Array.isArray(plan.feeds) ? plan.feeds : []).map(async (f: any) => {
          const url = String(f?.url ?? '');
          try {
            if (!parseFeed((await fetchText(url)).body).length) throw new Error('пустая лента');
            add('rss', String(f?.title ?? ''), url);
          } catch {
            rejected.push(url);
          }
        }),
        ...(Array.isArray(plan.pages) ? plan.pages : []).map(async (pg: any) => {
          const url = String(pg?.url ?? '');
          try {
            if (htmlText((await fetchText(url)).body).length < 500) throw new Error('пустая страница');
            add('web', String(pg?.title ?? ''), url);
          } catch {
            rejected.push(url);
          }
        }),
      ]);
      return { desk: desk(d.id), sources: listSources(d.id).length, rejected };
    },
    async setAvatar(deskId: number, path: string) {
      const d = desk(deskId);
      const dir = join(deps.dataDir, 'channels', String(d.id));
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `avatar-${now()}${extname(path) || '.png'}`);
      copyFileSync(path, dest);
      await deps.engine.setChatPhoto(d.accountId, d.chatId, dest);
    },
    async redrawCover(id: number): Promise<ChannelPost> {
      const row = raw.prepare('SELECT issue, desk_id, status FROM channel_posts WHERE id = ?').get(id) as Row | undefined;
      if (!row?.issue || row.status === 'published') throw new Error('Обложку можно перерисовать только у черновика нового формата');
      const image = await drawCover(desk(row.desk_id), JSON.parse(row.issue));
      if (!image) throw new Error('Обложка не нарисовалась: проверьте ключ fal.ai');
      raw.prepare('UPDATE channel_posts SET image = ? WHERE id = ?').run(image, id);
      return post(id);
    },
    // A published post again, in the current layout: the same issue and cover rendered anew, the old message taken down
    async repost(id: number): Promise<ChannelPost> {
      const row = raw.prepare('SELECT * FROM channel_posts WHERE id = ?').get(id) as Row | undefined;
      if (!row?.issue) throw new Error('Перевыложить можно только пост нового формата');
      const d = desk(row.desk_id);
      const text = renderIssue(JSON.parse(row.issue), { own: d.links === 'none', username: d.username });
      const copy = Number(raw.prepare('INSERT INTO channel_posts(desk_id, kind, text, image, item_ids, slot_key, issue, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
        .run(d.id, row.kind, text, row.image, row.item_ids, row.slot_key, row.issue, now()).lastInsertRowid);
      if (row.status === 'published' && row.message_id) {
        await deps.engine.deleteMessages(d.accountId, d.chatId, [row.message_id]);
        raw.prepare("UPDATE channel_posts SET status = 'rejected', error = 'перевыложен' WHERE id = ?").run(id);
      }
      return publish(copy);
    },
    // a rejected draft gives its items back
    rejectPost(id: number) {
      const p = post(id);
      raw.prepare("UPDATE channel_posts SET status = 'rejected' WHERE id = ?").run(id);
      if (p.itemIds.length) {
        raw.prepare(`UPDATE channel_items SET status = 'new' WHERE status = 'used' AND COALESCE(story_id, id) IN
          (SELECT COALESCE(story_id, id) FROM channel_items WHERE id IN (${p.itemIds.map(() => '?').join(',')}))`).run(...p.itemIds);
      }
    },
  };
}

export type Channels = ReturnType<typeof createChannels>;

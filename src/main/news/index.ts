// «Новости»: channels the owner follows without subscribing. Every hour their new posts are scored by Jev against
// Settings.newsInterests («worth a repost or a review?»); worthy posts get a short summary from the main LLM and wait
// in the list; a repost or review draft is written on request.
import type { AppEvent, NewsChannel, NewsItem, NewsStatus, Settings } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { mapPool, postSystemOne } from '../ai/jev';
import { chatCompletion, chatJsonCompletion } from '../ai/llm';

const POSTS_PER_READ = 30;
const FIRST_READ_MS = 3 * 86400_000; // a new channel: only the last three days, not its whole archive
const MIN_TEXT = 80; // reactions, one-liners and bare links are not news
const MIN_SCORE = 50;
const CHUNK = 10;
const MAX_TEXT = 1500;
export const NEWS_INTERVAL_MS = 3600_000;

const DDL = `
CREATE TABLE IF NOT EXISTS news_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  username TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_message_id INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES news_channels(id) ON DELETE CASCADE,
  tg_chat_id INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  text TEXT NOT NULL,
  link TEXT,
  date INTEGER NOT NULL,
  score INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  created_at INTEGER NOT NULL,
  UNIQUE(tg_chat_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS news_items_date ON news_items(date);
`;

type Row = Record<string, any>;

function toChannel(r: Row): NewsChannel {
  return {
    id: r.id, tgChatId: r.tg_chat_id, title: r.title, username: r.username, enabled: !!r.enabled,
    lastMessageId: r.last_message_id, lastCheckedAt: r.last_checked_at, createdAt: r.created_at,
  };
}

function toItem(r: Row): NewsItem {
  return {
    id: r.id, channelId: r.channel_id, channelTitle: r.channel_title ?? '', tgChatId: r.tg_chat_id,
    tgMessageId: r.tg_message_id, text: r.text, link: r.link, date: r.date, score: r.score, summary: r.summary,
    why: r.why, status: r.status, createdAt: r.created_at,
  };
}

export interface NewsDeps {
  db: Db;
  engine: TelegramEngine;
  emit: (e: AppEvent) => void;
  getSettings: () => Settings;
  // replaceable in tests
  score?: (interests: string, posts: string[]) => Promise<number[]>;
  summarize?: (interests: string, post: string) => Promise<{ summary: string; why: string }>;
}

// One Jev call per ten posts: a Noul per post
export async function jevNewsScores(getSettings: () => Settings, interests: string, posts: string[]): Promise<number[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < posts.length; i += CHUNK) chunks.push(posts.slice(i, i + CHUNK));
  const parts = await mapPool(chunks, 3, async (chunk) => {
    const questions: Record<string, object> = {};
    chunk.forEach((_, i) => {
      questions[`worth_${i}`] = {
        type: 'noul',
        instructions:
          `The owner follows these topics: \`interests\`. Is \`posts[${i}].text\` news, a new tool or feature, a case ` +
          `with numbers or a useful insight on these topics that is worth reposting or reviewing in the owner's channel ` +
          `(not an ad, not a giveaway, not a promo of a course or a chat, not chatter)?`,
      };
    });
    const data = await postSystemOne(getSettings, {
      state: { interests, posts: chunk.map((t) => ({ text: t.slice(0, MAX_TEXT) })) },
      questions,
    });
    const answers = (data.answers ?? {}) as Record<string, { noul?: number }>;
    return chunk.map((_, i) => Math.round((answers[`worth_${i}`]?.noul ?? 0) * 100));
  });
  return parts.flat();
}

async function llmSummary(getSettings: () => Settings, interests: string, post: string) {
  const raw = (await chatJsonCompletion(getSettings, [
    {
      role: 'system',
      content:
        'Ты помогаешь маркетологу держать руку на пульсе. По посту из Telegram-канала ответь JSON: ' +
        '{"summary":"1–2 предложения: что произошло, по-русски, без воды","why":"одна фраза: чем это полезно владельцу с его интересами"}',
    },
    { role: 'user', content: `Интересы владельца: ${interests}\n\nПост:\n${post.slice(0, 4000)}` },
  ], { temperature: 0.2 })) as { summary?: string; why?: string };
  return { summary: String(raw.summary ?? '').trim(), why: String(raw.why ?? '').trim() };
}

export function createNews(deps: NewsDeps) {
  const { db, engine, emit, getSettings } = deps;
  db.raw.exec(DDL);
  const score = deps.score ?? ((interests: string, posts: string[]) => jevNewsScores(getSettings, interests, posts));
  const summarize = deps.summarize ?? ((interests: string, post: string) => llmSummary(getSettings, interests, post));
  let running: Promise<number> | null = null;

  const accountId = () => db.listAccounts().find((a) => a.status === 'authorized')?.id;
  const getChannel = (id: number) => {
    const r = db.raw.prepare('SELECT * FROM news_channels WHERE id = ?').get(id) as Row | undefined;
    if (!r) throw new Error(`news channel ${id} not found`);
    return toChannel(r);
  };
  const getItem = (id: number) => {
    const r = db.raw.prepare(
      'SELECT i.*, c.title AS channel_title FROM news_items i JOIN news_channels c ON c.id = i.channel_id WHERE i.id = ?',
    ).get(id) as Row | undefined;
    if (!r) throw new Error(`news item ${id} not found`);
    return toItem(r);
  };

  async function readChannel(ch: NewsChannel, acc: number): Promise<number> {
    const now = Date.now();
    const history = await engine.getMessagesBefore(acc, ch.tgChatId, null, POSTS_PER_READ);
    const since = ch.lastMessageId ? 0 : now - FIRST_READ_MS;
    const fresh = history.filter((m: TgMessage) => m.messageId > ch.lastMessageId && m.date >= since && m.text.trim().length >= MIN_TEXT);
    const newest = history.reduce((a, m) => Math.max(a, m.messageId), ch.lastMessageId);
    db.raw.prepare('UPDATE news_channels SET last_message_id = ?, last_checked_at = ? WHERE id = ?').run(newest, now, ch.id);
    if (fresh.length === 0) return 0;

    const interests = getSettings().newsInterests;
    const scores = await score(interests, fresh.map((m) => m.text));
    let added = 0;
    for (const [i, m] of fresh.entries()) {
      if (scores[i] < MIN_SCORE) continue;
      let about = { summary: '', why: '' };
      try {
        about = await summarize(interests, m.text);
      } catch (err) {
        console.error('news summary', err); // the post is still worth showing without a summary
      }
      const res = db.raw.prepare(
        `INSERT INTO news_items(channel_id, tg_chat_id, tg_message_id, text, link, date, score, summary, why, created_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      ).run(ch.id, m.chatId, m.messageId, m.text, m.link, m.date, scores[i], about.summary, about.why, now);
      if (!res.changes) continue;
      added++;
      emit({ type: 'news:new', item: getItem(Number(res.lastInsertRowid)) });
    }
    return added;
  }

  async function readAll(): Promise<number> {
    const acc = accountId();
    if (acc == null) throw new Error('Подключите рабочий аккаунт Telegram');
    if (!getSettings().jevApiKey.trim()) throw new Error('Для оценки новостей нужен ключ Jev в настройках');
    let added = 0;
    for (const ch of api.channels().filter((c) => c.enabled)) {
      try {
        added += await readChannel(ch, acc);
      } catch (err) {
        console.error('news channel', ch.title, err);
      }
    }
    return added;
  }

  const api = {
    channels(): NewsChannel[] {
      return (db.raw.prepare('SELECT * FROM news_channels ORDER BY title').all() as Row[]).map(toChannel);
    },

    async addChannel(linkOrUsername: string): Promise<NewsChannel> {
      const acc = accountId();
      if (acc == null) throw new Error('Подключите рабочий аккаунт Telegram');
      const chat = await engine.resolveChat(acc, linkOrUsername.trim());
      if (chat.kind !== 'channel') throw new Error(`«${chat.title}» — не канал. Чаты добавляются в «Тематики» как источники`);
      db.raw.prepare(
        `INSERT INTO news_channels(tg_chat_id, title, username, created_at) VALUES(?, ?, ?, ?)
         ON CONFLICT(tg_chat_id) DO UPDATE SET title = excluded.title, username = excluded.username, enabled = 1`,
      ).run(chat.chatId, chat.title, chat.username, Date.now());
      const ch = toChannel(db.raw.prepare('SELECT * FROM news_channels WHERE tg_chat_id = ?').get(chat.chatId) as Row);
      void api.runNow().catch((err) => console.error('news first read', err instanceof Error ? err.message : err));
      return ch;
    },

    updateChannel(id: number, patch: Partial<Pick<NewsChannel, 'enabled'>>): NewsChannel {
      if (patch.enabled !== undefined) db.raw.prepare('UPDATE news_channels SET enabled = ? WHERE id = ?').run(Number(patch.enabled), id);
      return getChannel(id);
    },

    removeChannel(id: number) {
      db.raw.prepare('DELETE FROM news_items WHERE channel_id = ?').run(id);
      db.raw.prepare('DELETE FROM news_channels WHERE id = ?').run(id);
    },

    items(status: NewsStatus | 'all' = 'new'): NewsItem[] {
      const where = status === 'all' ? "i.status != 'dismissed'" : 'i.status = ?';
      const args = status === 'all' ? [] : [status];
      return (db.raw.prepare(
        `SELECT i.*, c.title AS channel_title FROM news_items i JOIN news_channels c ON c.id = i.channel_id
         WHERE ${where} ORDER BY i.date DESC LIMIT 300`,
      ).all(...args) as Row[]).map(toItem);
    },

    setStatus(id: number, status: NewsStatus): NewsItem {
      db.raw.prepare('UPDATE news_items SET status = ? WHERE id = ?').run(status, id);
      return getItem(id);
    },

    async draft(id: number, kind: 'repost' | 'review'): Promise<string> {
      const item = getItem(id);
      const task = kind === 'repost'
        ? 'Перескажи новость своими словами для своего Telegram-канала: 3–6 предложений, живо, без канцелярита и ' +
          'эмодзи-гирлянд, факты не выдумывай. В конце строка «Источник: <ссылка>».'
        : 'Напиши обзор для своего Telegram-канала: что произошло, что это значит для маркетологов и бизнеса, как ' +
          'применить или чего ждать; 6–12 предложений, своё мнение, факты только из поста. В конце «Источник: <ссылка>».';
      const text = await chatCompletion(getSettings, [
        { role: 'system', content: `Ты пишешь посты для канала владельца. Интересы канала: ${getSettings().newsInterests}. ${task}` },
        { role: 'user', content: `Канал-источник: ${item.channelTitle}\nСсылка: ${item.link ?? 'нет'}\n\nПост:\n${item.text.slice(0, 6000)}` },
      ], { temperature: 0.6 });
      db.raw.prepare("UPDATE news_items SET status = 'used' WHERE id = ? AND status != 'dismissed'").run(id);
      return text.trim();
    },

    // One read at a time: the hourly timer and the «Обновить» button share it
    runNow(): Promise<number> {
      running ??= readAll().finally(() => {
        running = null;
      });
      return running;
    },
  };
  return api;
}

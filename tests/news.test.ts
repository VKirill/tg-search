import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createNews } from '../src/main/news';
import type { AppEvent } from '../src/shared/types';
import { FakeEngine, makeMsg } from './fakes';

const LONG = ' — подробности, цифры и выводы для маркетологов и владельцев бизнеса в этом посте.';

function setup(scores: Record<string, number>) {
  const db = new Db(':memory:');
  db.setSettings({ jevApiKey: 'k' });
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized' });
  const engine = new FakeEngine();
  engine.chats.set(-100, { chatId: -100, title: 'ИИ для маркетолога', username: 'ai_news', kind: 'channel', memberCount: 9000, isMember: false, description: '' });
  engine.resolveMap.set('@ai_news', engine.chats.get(-100)!);
  const events: AppEvent[] = [];
  const scored: string[][] = [];
  const news = createNews({
    db, engine, emit: (e) => events.push(e), getSettings: () => db.getSettings(),
    score: async (_i, posts) => {
      scored.push(posts);
      return posts.map((p) => scores[p.split(' — ')[0]] ?? 0);
    },
    summarize: async (_i, post) => ({ summary: `Кратко: ${post.split(' — ')[0]}`, why: 'Повод для обзора' }),
  });
  return { db, engine, news, events, scored };
}

describe('news', () => {
  it('reads a channel without subscribing, keeps worthy posts and reads only new ones next time', async () => {
    const { engine, news, events, scored } = setup({ 'Вышла новая видеомодель': 90, 'Скидка на курс': 10 });
    const now = Date.now();
    engine.setHistory(-100, [
      makeMsg(-100, 1, 'Старый пост про нейросети' + LONG, { date: now - 10 * 86400_000, senderUserId: null }),
      makeMsg(-100, 2, 'Вышла новая видеомодель' + LONG, { date: now - 3600_000, senderUserId: null }),
      makeMsg(-100, 3, 'Скидка на курс' + LONG, { date: now - 1800_000, senderUserId: null }),
      makeMsg(-100, 4, '🔥🔥🔥', { date: now - 600_000, senderUserId: null }),
    ]);
    const ch = await news.addChannel('@ai_news');
    expect(ch).toMatchObject({ title: 'ИИ для маркетолога', lastMessageId: 0 });
    await news.runNow();
    expect(engine.joinCalls).toEqual([]);
    expect(scored.flat().map((p) => p.split(' — ')[0])).toEqual(['Вышла новая видеомодель', 'Скидка на курс']);
    const items = news.items();
    expect(items.map((i) => [i.tgMessageId, i.score, i.summary])).toEqual([[2, 90, 'Кратко: Вышла новая видеомодель']]);
    expect(events.filter((e) => e.type === 'news:new')).toHaveLength(1);

    scored.length = 0;
    engine.setHistory(-100, [...(await engine.getMessagesBefore(1, -100, null, 30)), makeMsg(-100, 5, 'Вышла новая видеомодель' + ' 2' + LONG, { date: now, senderUserId: null })]);
    await news.runNow();
    expect(scored.flat()).toHaveLength(1); // only post 5
  });

  it('refuses a group: chats go to topics as sources', async () => {
    const { engine, news } = setup({});
    engine.chats.set(-200, { chatId: -200, title: 'Чат селлеров', username: 'sellers', kind: 'supergroup', memberCount: 500, isMember: true, description: '' });
    engine.resolveMap.set('@sellers', engine.chats.get(-200)!);
    await expect(news.addChannel('@sellers')).rejects.toThrow(/не канал/);
  });

  it('statuses: saved and dismissed leave the new list', async () => {
    const { engine, news } = setup({ 'Пост А': 80, 'Пост Б': 70 });
    engine.setHistory(-100, [makeMsg(-100, 1, 'Пост А' + LONG, { senderUserId: null }), makeMsg(-100, 2, 'Пост Б' + LONG, { senderUserId: null })]);
    await news.addChannel('@ai_news');
    await news.runNow();
    const [a, b] = news.items();
    news.setStatus(a.id, 'saved');
    news.setStatus(b.id, 'dismissed');
    expect(news.items()).toEqual([]);
    expect(news.items('saved').map((i) => i.id)).toEqual([a.id]);
    expect(news.items('all').map((i) => i.id)).toEqual([a.id]);
  });
});

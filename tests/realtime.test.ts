import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { createRealtime } from '../src/main/pipeline/realtime';
import { DEFAULT_AUTOPILOT } from '../src/shared/types';
import { FakeAi, FakeEngine, makeChat, makeMsg } from './fakes';
describe('createRealtime', () => {
  let db: Db;
  let engine: FakeEngine;
  let ai: FakeAi;
  const events: unknown[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    db = new Db(':memory:');
    engine = new FakeEngine();
    ai = new FakeAi();
    events.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setupSource(chatId: number) {
    const acc = db.upsertAccountByPhone('+7999');
    db.updateAccount(acc.id, { status: 'authorized' });
    const project = db.createProject({
      name: 'Proj',
      task: 'clients',
      target: 't',
      offer: 'o',
      criteria: '',
      geo: [],
      languages: [],
      accountIds: [acc.id],
      materials: [],
      keywords: [],
    });
    db.addSource({
      projectId: project.id,
      tgChatId: chatId,
      title: 'Chat',
      username: 'c',
      kind: 'supergroup',
      memberCount: 10,
      foundBy: 'manual',
      accountId: acc.id,
      status: 'active',
    });
    return project.id;
  }

  it('dedupes same message from two accounts into one qualify call', async () => {
    const chatId = 100;
    setupSource(chatId);
    ai.qualifyResults = [
      { key: `${chatId}:1`, score: 80, label: 'demand', reason: 'ok' },
    ];
    const rt = createRealtime({ db, engine, ai, emit: (e) => events.push(e) });
    rt.start();
    const m = makeMsg(chatId, 1, 'ищу команду для разработки сайта');
    engine.emitChat(1, m);
    engine.emitChat(2, m);
    await vi.advanceTimersByTimeAsync(3000);
    expect(ai.qualifyCalls).toBe(1);
    expect(events.filter((e) => (e as { type: string }).type === 'lead:new')).toHaveLength(1);
    rt.stop();
  });

  it('listens to every chat the account is in: first message adds the chat as a source', async () => {
    const projectId = setupSource(200);
    engine.chats.set(999, makeChat(999, 'Новый чат'));
    const rt = createRealtime({ db, engine, ai, emit: (e) => events.push(e) });
    rt.start();
    engine.emitChat(1, makeMsg(999, 1, 'короткий'));
    engine.emitChat(1, makeMsg(999, 2, 'длинное сообщение из чата, которого ещё нет в источниках'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(ai.qualifyCalls).toBe(1);
    const src = db.findSource(projectId, 999)!;
    expect(src.foundBy).toBe('member');
    expect(src.status).toBe('active');
    rt.stop();
  });

  it('ignores rejected chats and accounts outside the project', async () => {
    const projectId = setupSource(200);
    db.updateSource(db.findSource(projectId, 200)!.id, { status: 'rejected' });
    engine.chats.set(500, makeChat(500));
    const rt = createRealtime({ db, engine, ai, emit: (e) => events.push(e) });
    rt.start();
    engine.emitChat(1, makeMsg(200, 1, 'сообщение из отклонённого чата, длинное'));
    engine.emitChat(42, makeMsg(500, 2, 'сообщение от аккаунта не из проекта'));
    await vi.advanceTimersByTimeAsync(3000);
    expect(ai.qualifyCalls).toBe(0);
    expect(db.findSource(projectId, 500)).toBeUndefined();
    rt.stop();
  });

  it('flushes immediately at 20 messages', async () => {
    const chatId = 300;
    setupSource(chatId);
    const rt = createRealtime({ db, engine, ai, emit: (e) => events.push(e) });
    rt.start();
    for (let i = 1; i <= 20; i++) {
      engine.emitChat(1, makeMsg(chatId, i, `сообщение ${i} с достаточной длиной`));
    }
    await Promise.resolve();
    expect(ai.qualifyCalls).toBe(1);
    rt.stop();
  });
});

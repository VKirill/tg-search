import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { createBroadcaster, isChatDue } from '../src/main/pipeline/broadcaster';
import { todayLocal } from '../src/main/pipeline/limiter';
import { passthroughSpinner } from '../src/main/ai/spinner';
import type { TextSpinner } from '../src/main/ai/types';
import type { AppEvent } from '../src/shared/types';
import { FakeEngine, makeChat } from './fakes';

function setup() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const events: AppEvent[] = [];
  const emit = (e: AppEvent) => events.push(e);
  const acc1 = db.upsertAccountByPhone('+79990001111');
  const acc2 = db.upsertAccountByPhone('+79990002222');
  db.updateAccount(acc1.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  db.updateAccount(acc2.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  const spinner: TextSpinner = passthroughSpinner;
  const broadcaster = createBroadcaster({ db, engine, spinner, emit });
  return { db, engine, broadcaster, events, acc1, acc2 };
}

describe('broadcaster create', () => {
  it('resolves links and reports failed ones', async () => {
    const { engine, broadcaster, acc1 } = setup();
    const c1 = makeChat(101, 'One');
    engine.resolveMap.set('@one', c1);
    engine.failResolve.add('@bad');

    await expect(
      broadcaster.create({
        name: 'Offer',
        text: 'Hello @shop 100₽',
        accountIds: [acc1.id],
        chatLinks: ['@one', '@bad'],
        intervalHours: 24,
        spin: false,
      }),
    ).rejects.toThrow('Не удалось найти чаты: @bad');

    const b = await broadcaster.create({
      name: 'Offer',
      text: 'Hello',
      accountIds: [acc1.id],
      chatLinks: ['@one'],
      intervalHours: 24,
      spin: false,
    });
    expect(b.enabled).toBe(false);
    expect(b.chats).toHaveLength(1);
    expect(b.chats[0].tgChatId).toBe(101);
  });
});

describe('broadcaster tick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('posts only due chats when enabled', async () => {
    const { db, engine, broadcaster, acc1, acc2 } = setup();
    const c1 = makeChat(201);
    const c2 = makeChat(202);
    engine.resolveMap.set('@a', c1);
    engine.resolveMap.set('@b', c2);
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id, acc2.id],
      chatLinks: ['@a', '@b'],
      intervalHours: 24,
      spin: false,
    });
    db.updateBroadcast(b.id, { enabled: true });
    const now = 1_700_000_000_000;
    await broadcaster.tick(now);
    expect(engine.posted).toHaveLength(2);

    engine.posted.length = 0;
    await broadcaster.tick(now + 60_000);
    expect(engine.posted).toHaveLength(0);
  });

  it('respects interval across ticks', async () => {
    const { db, engine, broadcaster, acc1 } = setup();
    const c1 = makeChat(301);
    engine.resolveMap.set('@a', c1);
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id],
      chatLinks: ['@a'],
      intervalHours: 1,
      spin: false,
    });
    db.updateBroadcast(b.id, { enabled: true });
    const t0 = 1_700_000_000_000;
    await broadcaster.tick(t0);
    expect(engine.posted).toHaveLength(1);
    const chat = db.getBroadcast(b.id).chats[0];
    const intervalMs = 3_600_000;

    engine.posted.length = 0;
    await broadcaster.tick(t0 + intervalMs - 1);
    expect(engine.posted).toHaveLength(0);

    engine.posted.length = 0;
    const dueAt = t0 + intervalMs + Math.floor(0.15 * intervalMs) + 1;
    await broadcaster.tick(dueAt);
    expect(engine.posted).toHaveLength(1);
    expect(isChatDue({ ...chat, lastPostedAt: t0 }, 1, dueAt)).toBe(true);
  });

  it('does not retry a failing chat before the interval passes', async () => {
    const { db, engine, broadcaster, acc1 } = setup();
    engine.resolveMap.set('@a', makeChat(401));
    const b = await broadcaster.create({
      name: 'X', text: 'Post', accountIds: [acc1.id], chatLinks: ['@a'], intervalHours: 1, spin: false,
    });
    db.updateBroadcast(b.id, { enabled: true });
    let attempts = 0;
    engine.sendToChat = async () => {
      attempts++;
      throw new Error('CHAT_SEND_PLAIN_FORBIDDEN');
    };
    const t0 = 1_700_000_000_000;
    await broadcaster.tick(t0);
    await broadcaster.tick(t0 + 60_000);
    await broadcaster.tick(t0 + 120_000);
    expect(attempts).toBe(1);
    expect(db.getBroadcast(b.id).chats[0].lastError).toBe('CHAT_SEND_PLAIN_FORBIDDEN');
    await broadcaster.tick(t0 + 3_600_000 + Math.floor(0.15 * 3_600_000) + 1);
    expect(attempts).toBe(2);
  });

  it('rotates across two accounts', async () => {
    const { db, engine, broadcaster, acc1, acc2 } = setup();
    engine.resolveMap.set('@a', makeChat(401));
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id, acc2.id],
      chatLinks: ['@a'],
      intervalHours: 24,
      spin: false,
    });
    db.updateBroadcast(b.id, { enabled: true });
    const now = 1_700_000_000_000;
    await broadcaster.tick(now);
    expect(engine.posted[0].accountId).toBe(acc1.id);

    db.updateBroadcastChat(b.id, 401, { lastPostedAt: null });
    engine.posted.length = 0;
    await broadcaster.tick(now + 1);
    expect(engine.posted[0].accountId).toBe(acc2.id);
  });

  it('skips when daily limit is reached', async () => {
    const { db, engine, broadcaster, acc1 } = setup();
    vi.setSystemTime(1_700_000_000_000);
    engine.resolveMap.set('@a', makeChat(501));
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id],
      chatLinks: ['@a'],
      intervalHours: 24,
      spin: false,
    });
    db.updateBroadcast(b.id, { enabled: true });
    db.updateAccount(acc1.id, { sentToday: 10, sentDay: todayLocal(1_700_000_000_000) });
    const r = await broadcaster.runNow(b.id);
    expect(r.posted).toBe(0);
    expect(r.skipped).toBe(1);
    expect(engine.posted).toHaveLength(0);
  });

  it('falls back to original text when spin fails', async () => {
    const { db, engine, acc1, events } = setup();
    const emit = (e: AppEvent) => events.push(e);
    const failSpinner: TextSpinner = {
      spin: async () => {
        throw new Error('llm down');
      },
    };
    const broadcaster = createBroadcaster({ db, engine, spinner: failSpinner, emit });
    engine.resolveMap.set('@a', makeChat(601));
    const b = await broadcaster.create({
      name: 'X',
      text: 'Original',
      accountIds: [acc1.id],
      chatLinks: ['@a'],
      intervalHours: 24,
      spin: true,
    });
    await broadcaster.runNow(b.id);
    expect(engine.posted[0].text).toBe('Original');
  });

  it('joins and retries on not-a-member for public chat', async () => {
    const { engine, broadcaster, acc1 } = setup();
    const chat = makeChat(701);
    engine.resolveMap.set('@pub', chat);
    engine.mustJoinPost.add(701);
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id],
      chatLinks: ['@pub'],
      intervalHours: 24,
      spin: false,
    });
    await broadcaster.runNow(b.id);
    expect(engine.joinCalls).toEqual([701]);
    expect(engine.posted).toHaveLength(1);
  });
});

describe('broadcaster runNow', () => {
  it('posts when disabled and returns counts', async () => {
    const { engine, broadcaster, acc1, acc2 } = setup();
    engine.resolveMap.set('@a', makeChat(801));
    engine.resolveMap.set('@b', makeChat(802));
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id, acc2.id],
      chatLinks: ['@a', '@b'],
      intervalHours: 24,
      spin: false,
    });
    expect(b.enabled).toBe(false);
    const r = await broadcaster.runNow(b.id);
    expect(r).toEqual({ posted: 2, skipped: 0, errors: 0 });
    expect(engine.posted).toHaveLength(2);
  });

  it('posts at most one chat per account per tick', async () => {
    const { engine, broadcaster, acc1 } = setup();
    engine.resolveMap.set('@a', makeChat(901));
    engine.resolveMap.set('@b', makeChat(902));
    const b = await broadcaster.create({
      name: 'X',
      text: 'Post',
      accountIds: [acc1.id],
      chatLinks: ['@a', '@b'],
      intervalHours: 24,
      spin: false,
    });
    const r = await broadcaster.runNow(b.id);
    expect(r).toEqual({ posted: 1, skipped: 1, errors: 0 });
    expect(engine.posted).toHaveLength(1);
  });
});

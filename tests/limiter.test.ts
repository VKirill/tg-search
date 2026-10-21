import { describe, expect, it } from 'vitest';
import type { Account } from '../src/shared/types';
import { afterSend, canSend, effectiveSentToday, limiterErrorMessage, todayLocal } from '../src/main/pipeline/limiter';

function account(partial: Partial<Account> = {}): Account {
  return {
    id: 1,
    phone: '+1',
    tgUserId: 1,
    username: null,
    firstName: null,
    lastName: null,
    photoPath: null,
    status: 'authorized',
    dailyLimit: 10,
    pauseSec: 180,
    sentToday: 0,
    sentDay: null,
    lastSentAt: null,
    isPrimary: true,
    ...partial,
  };
}

describe('limiter', () => {
  const day1 = new Date('2026-10-20T12:00:00').getTime();
  const day2 = new Date('2026-10-21T12:00:00').getTime();

  it('resets daily counter when sentDay is not today', () => {
    const a = account({ sentToday: 10, sentDay: '2026-10-19' });
    expect(effectiveSentToday(a, day1)).toBe(0);
    expect(canSend(a, day1)).toEqual({ ok: true });
  });

  it('blocks when daily limit reached', () => {
    const a = account({ sentToday: 10, sentDay: todayLocal(day1), dailyLimit: 10 });
    expect(canSend(a, day1)).toEqual({ ok: false, reason: 'daily' });
    expect(limiterErrorMessage({ reason: 'daily' })).toBe('Дневной лимит аккаунта исчерпан');
  });

  it('blocks during pause between sends', () => {
    const a = account({ sentDay: todayLocal(day1), sentToday: 1, lastSentAt: day1, pauseSec: 180 });
    const mid = day1 + 60_000;
    const r = canSend(a, mid);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('pause');
      expect(limiterErrorMessage(r)).toMatch(/ещё \d+ с/);
    }
    expect(canSend(a, day1 + 180_000)).toEqual({ ok: true });
  });

  it('afterSend bumps counter and sets day', () => {
    const a = account({ sentToday: 3, sentDay: todayLocal(day1) });
    const patch = afterSend(a, day1);
    expect(patch).toEqual({ sentToday: 4, sentDay: todayLocal(day1), lastSentAt: day1 });

    const fresh = account({ sentToday: 5, sentDay: '2026-10-19' });
    const patch2 = afterSend(fresh, day2);
    expect(patch2.sentToday).toBe(1);
    expect(patch2.sentDay).toBe(todayLocal(day2));
  });
});

describe('replies and the daily cap', () => {
  it('a reply ignores the daily cap and does not spend it, but keeps the pause', async () => {
    const { canSend, afterSend } = await import('../src/main/pipeline/limiter');
    const now = Date.now();
    const today = new Date(now);
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const acc = { dailyLimit: 10, sentToday: 10, sentDay: day, pauseSec: 60, lastSentAt: now - 120_000 } as never;
    expect(canSend(acc, now)).toEqual({ ok: false, reason: 'daily' });
    expect(canSend(acc, now, true)).toEqual({ ok: true });
    expect(afterSend(acc, now, true)).toEqual({ lastSentAt: now });
    const justSent = { ...(acc as object), lastSentAt: now - 10_000 } as never;
    expect(canSend(justSent, now, true)).toMatchObject({ ok: false, reason: 'pause' });
  });
});

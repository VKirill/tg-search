import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createTrusted, isFreeLead, trustedFor } from '../src/main/trusted';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeEngine, makeMsg } from './fakes';

function setup() {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized' });
  db.createProject({
    name: 'Клиенты', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [acc.id], materials: [], keywords: [],
  });
  const engine = new FakeEngine();
  engine.chats.set(777, { chatId: 777, title: 'Тестер', username: 'tester_friend', kind: 'private', memberCount: null, isMember: true, description: '' });
  engine.resolveMap.set('@tester_friend', engine.chats.get(777)!);
  const checkins: { leadId: number; note: string }[] = [];
  const trusted = createTrusted({ db, engine, emit: () => {}, checkin: async (leadId, note) => void checkins.push({ leadId, note }) });
  return { db, acc, trusted, checkins };
}

describe('trusted contacts', () => {
  it('a private message from a trusted contact opens a free personal-chat lead', () => {
    const { db, acc, trusted } = setup();
    trusted.save({ username: '@Tester_Friend', free: true });
    expect(trusted.leadForIncoming(makeMsg(777, 1, 'найди поставщиков', { senderUserId: 999, senderUsername: 'someone' }), acc.id)).toBeNull();
    const lead = trusted.leadForIncoming(makeMsg(777, 1, 'найди поставщиков', { senderUserId: 777, senderUsername: 'tester_friend' }), acc.id)!;
    expect(lead).toMatchObject({ authorUserId: 777, text: '', status: 'dialog' });
    expect(isFreeLead(db, lead)).toBe(true);
    expect(trustedFor(db, { username: null, userId: 777 })?.username).toBe('tester_friend'); // user id learned
  });

  it('daily check-in: once a day after the hour, first message introduces, not when we already talked', async () => {
    const { db, trusted, checkins } = setup();
    trusted.save({ username: 'tester_friend', dailyCheckin: true, checkinHour: 11 });
    const day = (h: number, d = 21) => new Date(2026, 9, d, h, 0);
    await trusted.checkinTick(day(9));
    expect(checkins).toHaveLength(0);
    await trusted.checkinTick(day(11));
    expect(checkins).toHaveLength(1);
    expect(checkins[0].note).toMatch(/Вы ещё не общались/);
    await trusted.checkinTick(day(15));
    expect(checkins).toHaveLength(1); // once a day

    const leadId = checkins[0].leadId;
    db.addMessage({ leadId, accountId: 1, direction: 'in', where: 'dm', kind: 'text', text: 'привет', mediaPath: null, durationSec: null,
      tgChatId: 777, tgMessageId: 5, date: day(10, 22).getTime(), auto: false });
    await trusted.checkinTick(day(12, 22));
    expect(checkins).toHaveLength(1); // talked today already
    await trusted.checkinTick(day(12, 23));
    expect(checkins).toHaveLength(2);
    expect(checkins[1].note).not.toMatch(/Вы ещё не общались/);
  });

  it('finds dialogs whose fresh last message is incoming (a reply lost on restart)', () => {
    const { db, acc, trusted } = setup();
    trusted.save({ username: 'tester_friend' });
    const lead = trusted.leadForIncoming(makeMsg(777, 1, 'x', { senderUserId: 777, senderUsername: 'tester_friend' }), acc.id)!;
    const add = (direction: 'in' | 'out', date: number) => db.addMessage({ leadId: lead.id, accountId: acc.id, direction, where: 'dm',
      kind: 'text', text: direction, mediaPath: null, durationSec: null, tgChatId: 777, tgMessageId: date, date, auto: false });
    const now = Date.now();
    add('out', now - 60_000);
    expect(db.leadsAwaitingReply(now - 3600_000)).toEqual([]);
    add('in', now - 30_000);
    expect(db.leadsAwaitingReply(now - 3600_000)).toEqual([lead.id]);
    expect(db.leadsAwaitingReply(now)).toEqual([]); // too old
  });
});

describe('human-like replies', () => {
  it('a reply with [next] goes as separate messages; a structured result stays one', async () => {
    const { splitReply } = await import('../src/main/agent/style');
    expect(splitReply('понял, береза и подъемник\n[next]\nпеределаю, через полчасика скину')).toEqual([
      'понял, береза и подъемник', 'переделаю, через полчасика скину',
    ]);
    expect(splitReply('## Карточка\n\n- пункт\n- пункт')).toHaveLength(1);
  });
});

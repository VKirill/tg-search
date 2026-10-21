import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { assessMessages, createSpamChats, guardSpamJoins, spamChatReason, spamVerdict } from '../src/main/dedupe/spamChats';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeEngine, makeMsg } from './fakes';

const SPUN = [
  'Всем привет! Нужно помочь с парой карточек. Оплата по результату. Пишите в личку — объясню все подробности',
  'Здравствуйте, ребята! Нужно сделать несколько карточек. Оплата сдельная. Пишите в личку — расскажу, что нужно',
  'Всем добрый день! Нужно сделать пару карточек. Оплата по результату. Пишите в личку — дам дополнительную информацию',
];
const LIVE = [
  'Подскажите, кто работал с фулфилментом в Казани?', 'Wildberries опять поднял комиссию на одежду, как считаете маржу?',
  'Ребята, у кого карточки ушли в теневой бан после смены фото?', 'Кто пробовал самовыкупы в этом месяце, есть смысл?',
  'Продам остатки детских курток, 40 штук, опт', 'Как вы отвечаете на негативные отзывы, шаблонами или вручную?',
  'Возвраты по браку съедают весь доход, что делать?', 'Нашёл нормального поставщика коробок в Москве, могу скинуть контакт',
  'Склад Коледино не принимает поставки до пятницы', 'Есть кто с Озона переехал на Яндекс Маркет? Как продажи?',
  'Подскажите сервис аналитики подешевле Mpstats', 'Реклама в поиске на ВБ стала дороже вдвое, у вас так же?',
  'Кто делал сертификацию на косметику, сколько стоило?', 'Сегодня ночью упали продажи, у всех так?',
  'Ищу партнёра на совместную закупку в Китае', 'Как правильно указать габариты, чтобы не переплачивать логистику?',
  'Платная приёмка на Электростали сколько сейчас?', 'Поделитесь опытом работы с блогерами в Инстаграме',
  'Подскажите бухгалтера на УСН для селлера', 'Карточку заблокировали за товарный знак, как оспорить?',
  'Есть ли смысл в FBS при маленьком обороте?', 'Кто знает, когда выплаты придут после праздников?',
  'Сделал новую инфографику, конверсия выросла на 30%', 'Ищу помещение под склад в Подольске недорого',
  'Как бороться с конкурентами, которые копируют фото?',
];

function setup() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized' });
  const project = db.createProject({
    name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [acc.id], materials: [], keywords: [],
  });
  const add = (tgChatId: number, title: string) => db.addSource({
    projectId: project.id, tgChatId, title, username: null, kind: 'supergroup', memberCount: 100, foundBy: 'manual',
    accountId: acc.id, status: 'active',
  });
  const spam = createSpamChats({ db, engine, emit: () => {} });
  return { db, engine, acc, add, spam };
}

// 30 campaign posts from 30 accounts, chat self-promo and one real question (the live @wb_partners_chats picture)
function spamChatHistory(chatId: number) {
  let id = 1;
  return [
    ...Array.from({ length: 30 }, (_, i) => makeMsg(chatId, id++, SPUN[i % 3], { senderUserId: 9000 + i })),
    ...Array.from({ length: 5 }, (_, i) => makeMsg(chatId, id++, `Наш чат партнёров WB — правила и реклама, выпуск ${i}`, { senderUserId: null, senderChatId: chatId })),
    makeMsg(chatId, id++, 'Подскажите, кто работал с фулфилментом в Казани, какие цены сейчас?', { senderUserId: 1 }),
  ];
}

function liveChatHistory(chatId: number) {
  return LIVE.map((text, i) => makeMsg(chatId, i + 1, text, { senderUserId: 100 + i }));
}

describe('spam chats', () => {
  it('measures live messages: campaigns, repeats and chat posts are not live', () => {
    expect(assessMessages(spamChatHistory(500))).toMatchObject({ messages: 36, live: 1 });
  });

  it('a spam chat is left and blocked; a live chat stays; joining a blocked chat fails', async () => {
    const { db, engine, acc, add, spam } = setup();
    const bad = add(500, 'WB партнёры');
    const good = add(600, 'Живой чат');
    engine.setHistory(500, spamChatHistory(500));
    engine.setHistory(600, liveChatHistory(600));

    const blocked = await spam.check();
    expect(blocked.map((c) => [c.tgChatId, c.reason])).toEqual([[500, '35 из 36 последних сообщений — спам и повторы']]);
    expect(engine.leftChats).toContain(500);
    expect(db.getSource(bad.id).status).toBe('spam');
    expect(db.getSource(good.id).status).toBe('active');

    const guarded = guardSpamJoins(engine, db);
    await expect(guarded.joinChat(acc.id, 500)).rejects.toThrow(/спам-чат/);
    await guarded.joinChat(acc.id, 600);
    expect(engine.joinCalls).toEqual([600]);
  });

  it('a chat without new text for a week is dead; a small active one is not judged', () => {
    const now = Date.now();
    expect(spamVerdict({ messages: 5, live: 5, newest: now - 8 * 86400_000 }, now)).toBe('нет новых сообщений за неделю');
    expect(spamVerdict({ messages: 0, live: 0, newest: null }, now)).toBe('нет новых сообщений за неделю');
    expect(spamVerdict({ messages: 10, live: 0, newest: now }, now)).toBeNull(); // too few to judge
  });

  it('owner blocks and unblocks a chat', async () => {
    const { db, engine, acc, add, spam } = setup();
    const source = add(500, 'WB партнёры');
    engine.chats.set(500, { chatId: 500, title: 'WB партнёры', username: 'wb_partners_chats', kind: 'supergroup', memberCount: 1000, isMember: true, description: '' });
    expect(await spam.blockByOwner(acc.id, 500)).toMatchObject({ source: 'owner', reason: 'отмечен вручную' });
    expect(spamChatReason(db, 500)).toBe('отмечен вручную');
    spam.unblock(500);
    expect(spamChatReason(db, 500)).toBeNull();
    expect(db.getSource(source.id).status).toBe('candidate');
  });
});

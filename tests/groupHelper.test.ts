import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createGroupHelper, parseSelection } from '../src/main/groupHelper';
import { FakeEngine, makeMsg } from './fakes';
import { createTrusted } from '../src/main/trusted';

const CHAT = -1003776810481;
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { cap?: string } = {}) {
  const db = new Db(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'gdz-'));
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 1, pauseSec: 0 });
  db.setSettings({ helperChats: JSON.stringify([{ chatId: CHAT, title: 'ГДЗ', username: 'gdz_chat_all', accountId: acc.id, enabled: true }]), helperDailyPerUser: opts.cap ?? '5' });
  const engine = new FakeEngine();
  const page = join(dataDir, 'page.jpg');
  writeFileSync(page, 'x');
  engine.files.set(77, page);
  const solved: string[] = [];
  const helper = createGroupHelper({
    db, engine, dataDir, emit: () => {}, getSettings: () => db.getSettings(), setSettings: (p) => db.setSettings(p),
    isTaskRequest: async (message, picture) => (picture || /реши|задач|найди/i.test(message) ? 0.9 : 0.1),
    describePhoto: async () => ({ caption: 'контрольная по физике, 9 класс', tasks: ['1', '2', '3', '4', '5'] }),
    solve: async ({ task }) => (solved.push(task), `## Решение\n**Ответ: 42**`),
  });
  return { db, engine, helper, acc, solved };
}

describe('task selection', () => {
  it('reads «все», numbers and marked tasks', () => {
    expect(parseSelection('все')).toBe('all');
    expect(parseSelection('реши всё пожалуйста')).toBe('all');
    expect(parseSelection('3')).toEqual(['3']);
    expect(parseSelection('2 и 5')).toEqual(['2', '5']);
    expect(parseSelection('реши номер 4 и задачу 12б')).toEqual(['4', '12б']);
    expect(parseSelection('спасибо большое')).toBeNull();
  });
});

describe('homework helper in a group', () => {
  it('chatter is ignored; a page with several tasks gets a poll for its author; only the author\'s vote counts', async () => {
    const { engine, helper, acc, solved } = setup();
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'всем привет, как дела у вас'));
    expect(engine.sent).toEqual([]);

    await helper.onMessage(acc.id, makeMsg(CHAT, 2, '', { senderUserId: 900, senderName: 'Аня Петрова', photo: { fileId: 77 } }));
    expect(engine.polls).toHaveLength(1);
    const poll = engine.polls[0];
    expect(poll).toMatchObject({ replyTo: 2, question: 'Аня, какие задания решить? Можно выбрать несколько', options: ['№ 1', '№ 2', '№ 3', '№ 4', '№ 5', 'Все'] });

    // someone else votes: nothing happens
    engine.pollVotes.set(`${poll.messageId}:5`, [123]);
    await helper.checkPolls();
    expect(solved).toEqual([]);
    // the author picks № 2 and № 5: the poll closes, 🔥 on the photo, the solving starts
    engine.pollVotes.set(`${poll.messageId}:1`, [900]);
    engine.pollVotes.set(`${poll.messageId}:4`, [900, 123]);
    await helper.checkPolls();
    await tick();
    expect(poll.stopped).toBe(true);
    expect(engine.reactions).toEqual([{ chatId: CHAT, messageId: 2, emoji: '🔥' }]); // once, when the photo was taken as a task
    expect(solved[0]).toContain('Решить: задачи № 2, № 5');
    expect(engine.sent.at(-1)?.text).toBe('## Решение\n**Ответ: 42**');
  });

  it('a text answer to the question counts only from its author', async () => {
    const { helper, acc, solved } = setup();
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, '', { senderUserId: 900, photo: { fileId: 77 } }));
    await helper.onMessage(acc.id, makeMsg(CHAT, 3, 'все', { senderUserId: 901 }));
    await tick();
    expect(solved).toEqual([]);
    await helper.onMessage(acc.id, makeMsg(CHAT, 4, 'все', { senderUserId: 900 }));
    await tick();
    expect(solved[0]).toContain('Решить: все задачи с фото');
    expect(helper.requests(10).map((r) => r.status)).toEqual(['done']);
  });

  it('a photo with the task named goes straight to solving; other chats and bots are not touched', async () => {
    const { engine, helper, acc, solved } = setup();
    await helper.onMessage(acc.id, makeMsg(-100999, 1, 'реши задачу 3', { photo: { fileId: 77 } }));
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, 'реши задачу 3', { senderIsBot: true }));
    expect(engine.sent).toEqual([]);
    await helper.onMessage(acc.id, makeMsg(CHAT, 3, 'реши задачу 3 пожалуйста', { photo: { fileId: 77 } }));
    await tick();
    expect(solved[0]).toContain('Решить: задачи 3');
    expect(engine.sent).toHaveLength(1);
  });

  it('the daily cap per member: the next request gets one note about the limit', async () => {
    const { engine, helper, acc, solved } = setup({ cap: '1' });
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'найди скорость течения: катер 36 км по течению за 2 часа', { senderUserId: 5 }));
    await tick();
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, 'реши ещё задачу про поезд и скорость', { senderUserId: 5 }));
    await helper.onMessage(acc.id, makeMsg(CHAT, 3, 'и ещё задачу реши про трубы', { senderUserId: 5 }));
    await tick();
    expect(solved).toHaveLength(1);
    expect(engine.sent.filter((s) => /закончились/.test(s.text))).toHaveLength(1);
  });

  it('after a restart it reads what came meanwhile: the author\'s «все» to the question is not lost', async () => {
    const { engine, helper, acc, solved } = setup();
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, '', { senderUserId: 900, photo: { fileId: 77 }, replyToMessageId: null }));
    const poll = engine.polls[0];
    engine.setHistory(CHAT, [makeMsg(CHAT, 3, 'все', { senderUserId: 900, replyToMessageId: poll.messageId })]);
    await helper.start();
    helper.stop();
    await tick();
    expect(solved[0]).toContain('Решить: все задачи с фото');
  });

  it('«свои люди» have no daily cap', async () => {
    const { db, engine, helper, acc, solved } = setup({ cap: '1' });
    createTrusted({ db, engine, emit: () => {}, checkin: async () => {} }).save({ username: 'vechkasov_kirill' });
    for (const id of [1, 2, 3]) await helper.onMessage(acc.id, makeMsg(CHAT, id, `реши задачу номер ${id} про поезд`, { senderUserId: 7, senderUsername: 'VECHKASOV_KIRILL' }));
    await tick();
    expect(solved).toHaveLength(3);
    expect(engine.sent.some((m) => /закончились/.test(m.text))).toBe(false);
  });
});

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createGroupHelper, parseSelection } from '../src/main/groupHelper';
import { FakeEngine, makeMsg } from './fakes';

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
  it('chatter is ignored; a page with several tasks gets «какое решить?»; «все» in reply solves it as a reply', async () => {
    const { engine, helper, acc, solved } = setup();
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'всем привет, как дела у вас'));
    expect(engine.sent).toEqual([]);

    await helper.onMessage(acc.id, makeMsg(CHAT, 2, '', { senderUserId: 900, photo: { fileId: 77 } }));
    expect(engine.sent.map((s) => s.text)).toEqual(['вижу на фото задания 1, 2, 3, 4, 5 — какое решить? напиши номер в ответ или «все»']);

    await helper.onMessage(acc.id, makeMsg(CHAT, 3, 'все', { senderUserId: 900 }));
    await tick();
    expect(solved[0]).toContain('Решить: все задачи с фото');
    expect(engine.reactions).toEqual([{ chatId: CHAT, messageId: 2, emoji: '🔥' }]); // on the task photo, once taken
    expect(engine.sent.at(-1)?.text).toBe('## Решение\n**Ответ: 42**');
    expect(helper.requests(10).map((r) => r.status)).toEqual(['done', 'ignored']);
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
});

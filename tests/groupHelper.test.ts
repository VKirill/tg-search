import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createGroupHelper, parseSelection } from '../src/main/groupHelper';
import { FakeEngine, makeMsg } from './fakes';
import { createTrusted } from '../src/main/trusted';

const CHAT = -1001234567890;
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(opts: { cap?: string; asGroup?: boolean; scenario?: 'tasks' | 'questions' | 'custom'; extra?: Record<string, unknown> } = {}) {
  const db = new Db(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'group-helper-'));
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 1, pauseSec: 0 });
  // the group follows a test scenario: its kind and behavior come from the options
  const kind = !opts.scenario || opts.scenario === 'tasks' ? 'tasks' : 'questions';
  db.setSettings({ helperScenarios: JSON.stringify([{ id: 'test', name: 'Тест', description: '', kind, ...opts.extra }]) });
  db.setSettings({ helperChats: JSON.stringify([{ chatId: CHAT, title: 'Учебный чат', username: 'study_help_chat', accountId: acc.id, enabled: true, asGroup: opts.asGroup ?? false, scenario: 'test', about: 'помощь с уроками и вопросы по учёбе' }]), helperDailyPerUser: opts.cap ?? '5' });
  const engine = new FakeEngine();
  const page = join(dataDir, 'page.jpg');
  writeFileSync(page, 'x');
  engine.files.set(77, page);
  const solved: string[] = [];
  const helper = createGroupHelper({
    db, engine, dataDir, emit: () => {}, getSettings: () => db.getSettings(), setSettings: (p) => db.setSettings(p),
    isRequest: async (chat, message, picture) => (picture || /реши|задач|найди|\?/i.test(message) ? 0.9 : 0.1),
    describePhoto: async () => ({ caption: 'контрольная по физике, 9 класс', tasks: ['1', '2', '3', '4', '5'] }),
    answer: async (chat, { task }) => (solved.push(`[${chat.kind}] ${task}`), `## Решение\n**Ответ: 42**`),
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
    createTrusted({ db, engine, emit: () => {}, checkin: async () => {} }).save({ username: 'own_person' });
    for (const id of [1, 2, 3]) await helper.onMessage(acc.id, makeMsg(CHAT, id, `реши задачу номер ${id} про поезд`, { senderUserId: 7, senderUsername: 'Own_Person' }));
    await tick();
    expect(solved).toHaveLength(3);
    expect(engine.sent.some((m) => /закончились/.test(m.text))).toBe(false);
  });

  it('on behalf of the group: no reaction, a «взял задачу» note instead, deleted when the solution comes', async () => {
    const { engine, helper, acc, solved } = setup({ asGroup: true });
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'реши задачу про поезд: 120 км за 1,5 часа', { senderUserId: 5 }));
    await tick(10);
    expect(solved).toHaveLength(1);
    expect(engine.reactions).toEqual([]);
    expect(engine.sent.map((m) => m.text)).toEqual(['🔥 взял задачу, решаю — минутку', '## Решение\n**Ответ: 42**']);
    expect(engine.deleted).toHaveLength(1);
  });

  it('«questions»: a question on the topic goes to the consultant with the group\'s description; no task polls', async () => {
    const { engine, helper, acc, solved } = setup({ scenario: 'questions' });
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'спасибо всем'));
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, 'а когда в этом году пробный экзамен?', { senderUserId: 9 }));
    await helper.onMessage(acc.id, makeMsg(CHAT, 3, '', { senderUserId: 10, photo: { fileId: 77 } }));
    await tick(10);
    expect(engine.polls).toEqual([]);
    expect(solved[0]).toMatch(/^\[questions\] Вопрос участника группы: а когда в этом году пробный экзамен\?/);
    expect(solved[0]).toContain('О группе: помощь с уроками и вопросы по учёбе');
    expect(solved).toHaveLength(2);
  });

  it('the group\'s own rules: keywords and threshold come first, Jev can be off, phrases are the group\'s', async () => {
    const { engine, helper, acc, solved, db } = setup({
      scenario: 'custom', asGroup: true,
      extra: { keywords: ['помогите'], threshold: 0.95, texts: { ack: 'принято!' } },
    });
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'реши задачу про поезд пожалуйста', { senderUserId: 5 })); // no keyword
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, 'помогите решить задачу про поезд', { senderUserId: 5 })); // 0.9 < 0.95
    await tick(10);
    expect(solved).toEqual([]);
    expect(helper.requests(10).map((r) => [r.status, r.score])).toEqual([['ignored', 0.9]]);

    // Jev off: every message with the keyword is answered, with the group's own «taken» phrase
    const [sc] = JSON.parse(db.getSettings().helperScenarios);
    db.setSettings({ helperScenarios: JSON.stringify([{ ...sc, jevCheck: false }]) });
    await helper.onMessage(acc.id, makeMsg(CHAT, 3, 'помогите, не понимаю тему', { senderUserId: 6 }));
    await tick(10);
    expect(engine.sent.map((m) => m.text)).toEqual(['принято!', '## Решение\n**Ответ: 42**']);
    expect(helper.requests(1)[0]).toMatchObject({ status: 'done', answer: '## Решение\n**Ответ: 42**', agent: 'consultant', score: 1 });
  });

  it('«only replies to the helper»: a reply to its answer counts, a new message does not', async () => {
    const { engine, helper, acc, solved, db } = setup({ scenario: 'questions', extra: { repliesOnly: true, jevCheck: false } });
    await helper.onMessage(acc.id, makeMsg(CHAT, 1, 'а какой учебник по алгебре лучше?', { senderUserId: 5 }));
    expect(solved).toEqual([]);
    // the helper answered something earlier: a reply to it is taken
    db.raw.prepare(`INSERT INTO helper_requests(chat_id, message_id, account_id, user_id, status, answer_id, created_at, updated_at)
      VALUES(?, 50, ?, 5, 'done', 777, 0, 0)`).run(CHAT, acc.id);
    await helper.onMessage(acc.id, makeMsg(CHAT, 2, 'а почему именно этот учебник?', { senderUserId: 5, replyToMessageId: 777 }));
    await tick(10);
    expect(solved).toHaveLength(1);
    expect(engine.sent).toHaveLength(1);
  });

  it('the sandbox says what filters and Jev think, without answering', async () => {
    const { engine, helper } = setup({ scenario: 'custom', extra: { keywords: ['реши'] } });
    const chat = helper.chats()[0];
    const sc = helper.scenarios().find((x) => x.id === 'test')!;
    expect(await helper.test(chat, 'привет всем')).toMatchObject({ answer: false, reason: 'нет ключевых слов' });
    expect(await helper.test(chat, 'реши задачу')).toMatchObject({ answer: true, score: 0.9 });
    expect(await helper.test(chat, 'реши задачу', { ...sc, threshold: 0.95 })).toMatchObject({ answer: false }); // unsaved edits of the scenario
    expect(engine.sent).toEqual([]);
  });

  it('scenarios: built-in ones change and reset, own ones are created and deleted; old per-group settings move into a scenario', async () => {
    const db = new Db(':memory:');
    const acc = db.upsertAccountByPhone('+79990001122');
    // a group set up before scenarios: behavior on the group itself
    db.setSettings({ helperChats: JSON.stringify([{ chatId: 1, title: 'Старая', username: null, accountId: acc.id, enabled: true, scenario: 'questions', keywords: ['помогите'] }]) });
    const helper = createGroupHelper({
      db, engine: new FakeEngine(), dataDir: mkdtempSync(join(tmpdir(), 'group-helper-')), emit: () => {},
      getSettings: () => db.getSettings(), setSettings: (p) => db.setSettings(p),
      isRequest: async () => 1, describePhoto: async () => ({ caption: '', tasks: [] }), answer: async () => 'ok',
    });
    expect(helper.chats()[0]).toMatchObject({ scenario: 'group-1' });
    expect(helper.chats()[0]).not.toHaveProperty('keywords');
    expect(helper.scenarios().find((s) => s.id === 'group-1')).toMatchObject({ kind: 'questions', keywords: ['помогите'], builtIn: false });

    const names = (list: { id: string; name: string }[]) => list.map((s) => s.id);
    expect(names(helper.scenarios()).slice(0, 4)).toEqual(['tasks', 'questions', 'knowledge', 'mentions']);
    helper.saveScenario({ ...helper.scenarios()[0], name: 'Мои задачи', threshold: 0.8 });
    expect(helper.scenarios()[0]).toMatchObject({ id: 'tasks', name: 'Мои задачи', threshold: 0.8, builtIn: true });
    helper.removeScenario('tasks');
    expect(helper.scenarios()[0]).toMatchObject({ name: 'Решение задач' });
    expect(helper.scenarios()[0].threshold).toBeUndefined();

    const created = helper.saveScenario({ id: '', name: 'Модерация', description: '', kind: 'questions' }).find((s) => s.name === 'Модерация')!;
    helper.saveChats([{ ...helper.chats()[0], scenario: created.id }]);
    helper.removeScenario(created.id);
    expect(helper.scenarios().some((s) => s.id === created.id)).toBe(false);
    expect(helper.chats()[0].scenario).toBe('tasks'); // its groups fall back to the default
  });
});

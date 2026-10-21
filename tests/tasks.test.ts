import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { createAgentTasks, type AgentTask } from '../src/main/agent/tasks';
import { createAssignTaskTool, createMakeXlsxTool, createSendTaskResultTool } from '../src/main/agent/tools/tasks';
import { freshTurnState } from '../src/main/agent/tools';
import { createTrusted } from '../src/main/trusted';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeEngine } from './fakes';

function setup() {
  const db = new Db(':memory:');
  const dataDir = mkdtempSync(join(tmpdir(), 'tasks-'));
  const project = db.createProject({
    name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [], materials: [], keywords: [],
  });
  const lead = db.addLead({
    projectId: project.id, sourceId: null, tgChatId: 777, tgMessageId: 0, authorUserId: 777, authorName: 'A',
    authorUsername: 'tester_friend', text: '', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
  })!;
  return { db, dataDir, lead };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('background tasks', () => {
  it('runs at most three at once, delivers each result with its files, the rest wait in the queue', async () => {
    const { db, dataDir, lead } = setup();
    const release: (() => void)[] = [];
    let running = 0;
    let peak = 0;
    const delivered: { id: number; text: string; files: string[] }[] = [];
    const tasks = createAgentTasks({
      db, dataDir, emit: () => {},
      run: (task, dir) => new Promise((resolve) => {
        running++;
        peak = Math.max(peak, running);
        if (task.agent === 'directologist') writeFileSync(join(dir, 'semantika.xlsx'), 'x');
        release.push(() => {
          running--;
          resolve(`результат ${task.id}`);
        });
      }),
      deliver: async (task, text, files) => void delivered.push({ id: task.id, text, files: files.map((f) => f.mime) }),
      fail: async () => {},
    });
    tasks.enqueue(lead.id, 'designer', 'карточки');
    tasks.enqueue(lead.id, 'directologist', 'семантика в Excel');
    tasks.enqueue(lead.id, 'copywriter', 'пост');
    tasks.enqueue(lead.id, 'researcher', 'поставщики');
    await tick();
    expect(peak).toBe(3);
    expect(tasks.open(lead.id).map((t: AgentTask) => t.status)).toEqual(['running', 'running', 'running', 'queued']);
    while (release.length) {
      release.shift()!();
      await tick();
      await tick();
    }
    expect(delivered.map((d) => d.id).sort()).toEqual([1, 2, 3, 4]);
    expect(delivered.find((d) => d.id === 2)?.files).toEqual(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']);
    expect(tasks.open(lead.id)).toEqual([]);
  });

  it('a failure is reported; a task interrupted by a restart runs again', async () => {
    const { db, dataDir, lead } = setup();
    const failed: string[] = [];
    let attempts = 0;
    const make = (run: () => Promise<string>) => createAgentTasks({
      db, dataDir, emit: () => {}, run, deliver: async () => {}, fail: async (_t, e) => void failed.push(e),
    });
    const broken = make(async () => {
      throw new Error('нет ключа');
    });
    broken.enqueue(lead.id, 'researcher', 'x');
    await tick();
    await tick();
    expect(failed).toEqual(['нет ключа']);

    db.raw.prepare("INSERT INTO agent_tasks(lead_id, agent, task, status, created_at) VALUES(?, 'copywriter', 'y', 'running', 0)").run(lead.id);
    const fresh = make(async () => {
      attempts++;
      return 'ok';
    });
    fresh.resume();
    await tick();
    await tick();
    expect(attempts).toBe(1);
  });

  it('assign_task: free for trusted contacts, needs a subscription otherwise', async () => {
    const { db, dataDir, lead } = setup();
    const queue = createAgentTasks({ db, dataDir, emit: () => {}, run: async () => 'ok', deliver: async () => {}, fail: async () => {} });
    const host = { db, engine: new FakeEngine(), emit: () => {}, getSettings: () => db.getSettings(), turnState: freshTurnState(), getTasks: () => queue };
    const tool = createAssignTaskTool(host as never);
    expect(await tool.run({ agent: 'researcher', task: 'x' }, { leadId: lead.id, clientId: 1, dryRun: false })).toMatch(/подписки/);
    createTrusted({ db, engine: new FakeEngine(), emit: () => {}, checkin: async () => {} }).save({ username: 'tester_friend' });
    expect(await tool.run({ agent: 'researcher', task: 'x' }, { leadId: lead.id, clientId: 1, dryRun: false })).toMatch(/Поручение #1/);
  });

  it('a finished result waits for the primary agent: it sends it as is under its intro, or asks for one free redo', async () => {
    const { db, dataDir, lead } = setup();
    const acc = db.upsertAccountByPhone('+79990001122');
    db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 50, pauseSec: 0 });
    db.updateProject(lead.projectId, { accountIds: [acc.id] });
    const reviews: number[] = [];
    const queue = createAgentTasks({
      db, dataDir, emit: () => {}, run: async (t) => `## Решение ${t.id}\n**Ответ: 3**`,
      deliver: async (t) => void reviews.push(t.id), fail: async () => {},
    });
    const engine = new FakeEngine();
    const turnState = freshTurnState();
    const host = { db, engine, emit: () => {}, getSettings: () => db.getSettings(), turnState, getTasks: () => queue };
    const ctx = { leadId: lead.id, clientId: null, dryRun: false };
    createTrusted({ db, engine, emit: () => {}, checkin: async () => {} }).save({ username: 'tester_friend' });
    const assign = createAssignTaskTool(host as never);
    const send = createSendTaskResultTool(host as never);

    expect(await assign.run({ agent: 'solver', task: 'задача' }, ctx)).toMatch(/на проверку/);
    await tick();
    await tick();
    expect(reviews).toEqual([1]);
    expect(engine.sent).toEqual([]); // nothing reaches the client before the check

    // a miss: one free redo, the original never goes out
    expect(await assign.run({ agent: 'solver', task: 'пересчитай', redo_of: 1 }, ctx)).toMatch(/#2 переделывает #1/);
    await tick();
    await tick();
    expect(await assign.run({ agent: 'solver', task: 'ещё раз', redo_of: 2 }, ctx)).toMatch(/уже переделывали/);
    expect(await send.run({ task_id: 1, intro: 'вот' }, ctx)).toMatch(/уже отправлено/);

    expect(await send.run({ task_id: 2, intro: 'готово, смотри' }, ctx)).toMatch(/отправлен/);
    expect(engine.sent.map((m) => m.text)).toEqual(['готово, смотри\n\n## Решение 2\n**Ответ: 3**']);
    expect(turnState.replyUsed).toBe(true);
    expect(await send.run({ task_id: 2, intro: 'ещё' }, ctx)).toMatch(/уже отправлено/);
  });

  it('make_xlsx writes a real workbook into the task folder', async () => {
    const { dataDir } = setup();
    const tool = createMakeXlsxTool({ taskDir: dataDir } as never);
    const out = await tool.run({
      filename: 'semantika.xlsx',
      sheets: [{ name: 'Семантика', rows: [['Группа', 'Фраза'], ['Кровать', 'купить кровать 200 на 200']] }],
    }, { leadId: 1, clientId: null, dryRun: false });
    expect(out).toMatch(/semantika\.xlsx готов/);
    expect(execFileSync('unzip', ['-l', join(dataDir, 'semantika.xlsx')], { encoding: 'utf8' })).toMatch(/xl\/worksheets\/sheet1\.xml/);
  });
});

describe('tool permissions', () => {
  it('an exact tool name beats the wildcard in any order', async () => {
    const { resolveToolPermission } = await import('../src/main/agent/permissions');
    expect(resolveToolPermission({ make_xlsx: 'allow', '*': 'deny' }, 'make_xlsx')).toBe('allow');
    expect(resolveToolPermission({ '*': 'deny', make_xlsx: 'allow' }, 'make_xlsx')).toBe('allow');
    expect(resolveToolPermission({ make_xlsx: 'allow', '*': 'deny' }, 'reply')).toBe('deny');
  });
});

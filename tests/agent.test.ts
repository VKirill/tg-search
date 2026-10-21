import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/main/db';
import { ensureAgentSchema } from '../src/main/agent/schema';
import { createOperator } from '../src/main/agent/operator';
import { listAgentSteps } from '../src/main/agent/store';
import type { AgentChatMessage, AgentCompletionResult, ToolCall } from '../src/main/agent/llm';
import { toolsToLlmDefs } from '../src/main/agent/tools';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager } from './fakes';
import type { MemoryStore } from '../src/main/memory/types';
import type { Billing } from '../src/main/billing/types';
import type { Asset } from '../src/shared/types';
import { createManagerAgent } from '../src/main/pipeline/managerAgent';

function setupDb() {
  const db = new Db(':memory:');
  ensureAgentSchema(db.raw, db);
  const engine = new FakeEngine();
  const ai = new FakeAi();
  const manager = new FakeManager();
  const events: import('../src/shared/types').AppEvent[] = [];
  const emit = (e: import('../src/shared/types').AppEvent) => events.push(e);
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 50, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 't',
    offer: 'o',
    criteria: '',
    sequence: [],
    manager: { ...DEFAULT_MANAGER, enabled: true, apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' },
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: [],
  });
  const lead = db.addLead({
    projectId: project.id,
    sourceId: null,
    tgChatId: 1,
    tgMessageId: 1,
    authorUserId: 500,
    authorName: 'Anna',
    authorUsername: 'anna',
    text: 'Привет',
    date: Date.now(),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
  db.setSettings({ operatorApiKey: 'test-key', ownerName: 'Кирилл' });
  const service = db.createService({
    kind: 'marketplace_card',
    name: 'Карточка',
    categoryId: null,
    enabled: true,
    priceMin: 500,
    priceMax: 3000,
    instructions: 'test',
    model: '',
    previewEnabled: true,
    revisions: 1, agent: '',
  });
  return { db, engine, ai, manager, emit, events, acc, project, lead, service };
}

function scriptedLlm(script: { tool_calls?: ToolCall[]; content?: string }[]) {
  let i = 0;
  return async (_messages: AgentChatMessage[], tools: ReturnType<typeof toolsToLlmDefs>): Promise<AgentCompletionResult> => {
    const step = script[i++] ?? { content: 'готово' };
    return {
      message: {
        role: 'assistant',
        content: step.content ?? null,
        tool_calls: step.tool_calls,
      },
      usageCostUsd: 0,
    };
  };
}

describe('operator agent', () => {
  it('reply sent once through limiter; second reply rejected', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        {
          tool_calls: [
            { id: '1', name: 'reply', arguments: JSON.stringify({ text: 'Первый' }) },
            { id: '2', name: 'reply', arguments: JSON.stringify({ text: 'Второй' }) },
          ],
        },
      ]),
    });
    const r = await operator.turn(lead.id);
    expect(r.reply).toBe('Первый');
    expect(engine.sent).toHaveLength(1);
    expect(r.steps.some((s) => s.tool === 'reply' && !s.ok && s.output.includes('уже'))).toBe(true);
  });

  it('price outside range rejected by create_or_update_order', async () => {
    const { db, engine, ai, manager, emit, lead, service } = setupDb();
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        {
          tool_calls: [
            {
              id: '1',
              name: 'create_or_update_order',
              arguments: JSON.stringify({ serviceId: service.id, brief: 'тест', price: 99999 }),
            },
          ],
        },
      ]),
    });
    const r = await operator.turn(lead.id);
    expect(r.steps[0].ok).toBe(false);
    expect(r.steps[0].output).toContain('вне вилки');
  });

  it('run_task blocked without subscription', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    const billing: Billing = {
      plans: () => [],
      status: () => ({ subscription: null, plan: null, daysLeft: null, tasksLeft: null, unpaid: [] }),
      subscribe: async () => {
        throw new Error('no');
      },
      consumeTask: () => false,
      recordPayment: () => {
        throw new Error('no');
      },
      check: async () => {
        throw new Error('no');
      },
      start: () => {},
      stop: () => {},
    };
    db.raw.prepare('UPDATE leads SET client_id = 1 WHERE id = ?').run(lead.id);
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      billing,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        { tool_calls: [{ id: '1', name: 'run_task', arguments: JSON.stringify({ instructions: 'найди' }) }] },
      ]),
    });
    const r = await operator.turn(lead.id, { dryRun: false });
    expect(r.steps[0].output).toContain('подписка');
  });

  it('run_task allowed with subscription quota', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    let consumed = false;
    const billing: Billing = {
      plans: () => [],
      status: () => ({
        subscription: {
          id: 1,
          clientId: 1,
          planId: 1,
          status: 'active',
          periodStart: Date.now(),
          periodEnd: Date.now() + 1e6,
          tasksUsed: 0,
          createdAt: Date.now(),
        },
        plan: null,
        daysLeft: 10,
        tasksLeft: 5,
        unpaid: [],
      }),
      subscribe: async () => {
        throw new Error('no');
      },
      consumeTask: () => {
        consumed = true;
        return true;
      },
      recordPayment: () => {
        throw new Error('no');
      },
      check: async () => {
        throw new Error('no');
      },
      start: () => {},
      stop: () => {},
    };
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      billing,
      dataDir: mkdtempSync(join(tmpdir(), 'tg-agent-')),
      executors: {
        homework: { estimate: async () => ({ price: 300, reason: '' }), preview: async () => ({ text: '', files: [] }), run: async () => ({ text: '', files: [] }) },
        marketplace_card: { estimate: async () => ({ price: 500, reason: '' }), preview: async () => ({ text: '', files: [] }), run: async () => ({ text: '', files: [] }) },
        image_gen: { estimate: async () => ({ price: 500, reason: '' }), preview: async () => ({ text: '', files: [] }), run: async () => ({ text: '', files: [] }) },
        copywriting: { estimate: async () => ({ price: 300, reason: '' }), preview: async () => ({ text: '', files: [] }), run: async () => ({ text: '', files: [] }) },
        assistant: {
          estimate: async () => ({ price: 500, reason: '' }),
          preview: async () => ({ text: 'план', files: [] }),
          run: async () => ({ text: 'Результат исследования', files: [] }),
        },
        agent: { estimate: async () => ({ price: 500, reason: '' }), preview: async () => ({ text: '', files: [] }), run: async () => ({ text: '', files: [] }) },
      },
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        { tool_calls: [{ id: '1', name: 'run_task', arguments: JSON.stringify({ instructions: 'найди' }) }] },
      ]),
    });
    db.raw.prepare('UPDATE leads SET client_id = 1 WHERE id = ?').run(lead.id);
    const r = await operator.turn(lead.id);
    expect(consumed).toBe(true);
    expect(r.steps[0].ok).toBe(true);
    expect(engine.sent.some((s) => s.text.includes('Результат'))).toBe(true);
  });

  it('send_asset refuses another client asset', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    const assets: Asset[] = [
      {
        id: 9,
        clientId: 999,
        orderId: null,
        path: '/tmp/x.jpg',
        mime: 'image/jpeg',
        name: 'x.jpg',
        role: 'from_client',
        caption: 'c',
        tags: [],
        createdAt: Date.now(),
      },
    ];
    const memory: MemoryStore = {
      ensureClient: () => null,
      clientForLead: () => ({ id: 1, tgUserId: 500, name: 'A', username: null, leadIds: [lead.id], createdAt: 0, lastSeenAt: null }),
      context: () => ({ text: '', tokens: 0 }),
      remember: () => {
        throw new Error('no');
      },
      search: () => ({ facts: [], episodes: [], assets }),
      searchAsync: async () => ({ facts: [], episodes: [], assets }),
      addAsset: () => {
        throw new Error('no');
      },
      onMessage: () => {},
      onOrder: () => {},
      stop: () => {},
    };
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      memory,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        { tool_calls: [{ id: '1', name: 'send_asset', arguments: JSON.stringify({ assetId: 9 }) }] },
      ]),
    });
    db.raw.prepare('UPDATE leads SET client_id = 1 WHERE id = ?').run(lead.id);
    const r = await operator.turn(lead.id);
    expect(r.steps[0].ok).toBe(false);
    expect(r.steps[0].output).toContain('другому клиенту');
  });

  it('dryRun changes nothing in db handoff flag', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        {
          tool_calls: [
            { id: '1', name: 'handoff', arguments: JSON.stringify({ reason: 'тест', summary: 'сводка' }) },
          ],
        },
      ]),
    });
    await operator.turn(lead.id, { dryRun: true });
    expect(db.getLead(lead.id).handoff).toBe(false);
    expect(engine.sent).toHaveLength(0);
  });

  it('trace stored and emitted', async () => {
    const { db, engine, ai, manager, emit, events, lead } = setupDb();
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: scriptedLlm([
        { tool_calls: [{ id: '1', name: 'reply', arguments: JSON.stringify({ text: 'Ок' }) }] },
      ]),
    });
    await operator.turn(lead.id);
    expect(events.some((e) => e.type === 'agent:step')).toBe(true);
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM agent_steps WHERE lead_id = ?').get(lead.id) as { n: number };
    expect(rows.n).toBeGreaterThan(0);
  });

  it('falls back to JSON manager when operator LLM fails twice', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    manager.replyResult = { reply: 'fallback', handoff: false, reason: '' };
    const fail = async (): Promise<AgentCompletionResult> => {
      throw new Error('LLM down');
    };
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: fail,
    });
    const r = await operator.turn(lead.id);
    expect(r.reply).toBe('fallback');
    expect(manager.replyCalls).toBe(1);
    expect(r.steps).toHaveLength(0);
    // the failure is visible to the owner, not swallowed
    const errors = listAgentSteps(db, lead.id).filter((s) => s.tool === 'operator_error');
    expect(errors).toHaveLength(2);
    expect(errors[0].output).toContain('LLM down');
  });
});

describe('manager agent with operator fallback', () => {
  it('uses manager after failed operator in pipeline', async () => {
    vi.useFakeTimers();
    const { db, engine, ai, manager, emit, lead } = setupDb();
    manager.replyResult = { reply: 'legacy', handoff: false, reason: '' };
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      complete: async () => {
        throw new Error('operator off');
      },
    });
    const agent = createManagerAgent({ db, engine, ai, manager, emit, operator });
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(DEFAULT_MANAGER.replyDelaySec * 1000);
    expect(manager.replyCalls).toBe(1);
    expect(engine.sent.some((s) => s.text === 'legacy')).toBe(true);
    agent.stop();
    vi.useRealTimers();
  });
});

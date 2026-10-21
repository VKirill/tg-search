import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/main/db';
import { ensureAgentSchema } from '../src/main/agent/schema';
import {
  createAgentDefs,
  defaultShippedAgentsDir,
  parseAgentFile,
  parseFrontMatter,
  splitFrontMatter,
} from '../src/main/agent/defs';
import { resolveToolPermission, effectiveToolPermission } from '../src/main/agent/permissions';
import { createOperator } from '../src/main/agent/operator';
import { createApprovals, type RunApprovedTool } from '../src/main/agent/approvals';
import { executeApprovedTool, makeToolHost } from '../src/main/agent/toolRunner';
import { runSubagentTurn } from '../src/main/agent/subagent';
import { createAgentExecutor } from '../src/main/executors/agent';
import type { AgentChatMessage, AgentCompletionResult, ToolCall } from '../src/main/agent/llm';
import { toolsToLlmDefs } from '../src/main/agent/tools';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager } from './fakes';

const shipped = defaultShippedAgentsDir();

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
    manager: { ...DEFAULT_MANAGER, enabled: true },
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: [],
  });
  db.updateProject(project.id, { agent: 'manager' });
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
  db.setSettings({ operatorApiKey: 'test-key', ownerName: 'Кирилл', glmApiKey: 'g' });
  return { db, engine, ai, manager, emit, events, project, lead };
}

function scriptedLlm(script: { tool_calls?: ToolCall[]; content?: string }[]) {
  let i = 0;
  return async (): Promise<AgentCompletionResult> => {
    const step = script[i++] ?? { content: 'готово' };
    return {
      message: { role: 'assistant', content: step.content ?? null, tool_calls: step.tool_calls },
      usageCostUsd: 0,
    };
  };
}

describe('agent defs', () => {
  it('parses front matter with permission globs', () => {
    const raw = `---
description: Test agent
mode: subagent
model: deepseek
temperature: 0.2
steps: 5
permission:
  "*": deny
  web_search: allow
  order_*: ask
---
Body line`;
    const { front, body } = splitFrontMatter(raw);
    const meta = parseFrontMatter(front);
    expect(body).toBe('Body line');
    expect(meta.steps).toBe(5);
    const def = parseAgentFile('t', raw, true);
    expect(resolveToolPermission(def.permission, 'web_search')).toBe('allow');
    expect(resolveToolPermission(def.permission, 'order_create')).toBe('ask');
    expect(resolveToolPermission(def.permission, 'reply')).toBe('deny');
  });

  it('user override and reset built-in', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    const custom = defs.get('manager');
    defs.save({ ...custom, prompt: 'CUSTOM PROMPT', description: 'custom' });
    expect(defs.get('manager').prompt).toBe('CUSTOM PROMPT');
    defs.remove('manager');
    expect(defs.get('manager').prompt).not.toBe('CUSTOM PROMPT');
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('injects company rules into operator system prompt', async () => {
    const { db, engine, ai, manager, emit, lead, project } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    defs.saveRules('# RULES TEST\n\nUnique rule marker XYZ');
    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => operator,
      runTool: async () => 'ok',
    });
    let seenSystem = '';
    const operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      agents: defs,
      getApprovals: () => approvals,
      complete: async (msgs) => {
        seenSystem = (msgs.find((m) => m.role === 'system') as { content: string }).content;
        return { message: { role: 'assistant', content: 'ok', tool_calls: [{ id: '1', name: 'reply', arguments: JSON.stringify({ text: 'hi' }) }] }, usageCostUsd: 0 };
      },
    });
    await operator.turn(lead.id);
    expect(seenSystem).toContain('Unique rule marker XYZ');
    expect(seenSystem).toContain('не говори «я не бот»');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('permissions and approvals', () => {
  it('deny and ask paths', async () => {
    const { db, engine, ai, manager, emit, lead, events } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    const mgr = defs.get('manager');
    defs.save({
      ...mgr,
      permission: { '*': 'allow', handoff: 'deny', offer_subscription: 'ask' },
    });
    let operator!: ReturnType<typeof createOperator>;
    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => operator,
      runTool: async () => 'ok',
    });
    operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      agents: defs,
      getApprovals: () => approvals,
      complete: async (msgs) => {
        const round = msgs.filter((m) => m.role === 'assistant').length;
        if (round === 0) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '1', name: 'handoff', arguments: JSON.stringify({ reason: 'x', summary: 's' }) }],
            },
            usageCostUsd: 0,
          };
        }
        if (round === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '2', name: 'offer_subscription', arguments: JSON.stringify({ planId: 1 }) }],
            },
            usageCostUsd: 0,
          };
        }
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: '3', name: 'reply', arguments: JSON.stringify({ text: 'Уточню у руководителя' }) }],
          },
          usageCostUsd: 0,
        };
      },
    });
    const r = await operator.turn(lead.id);
    expect(r.steps[0].output).toContain('запрещено');
    expect(r.steps[1].output).toContain('согласование');
    expect(events.some((e) => e.type === 'approval:update')).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('request_payment ask only above 3000', () => {
    const { db } = setupDb();
    const agent = parseAgentFile('m', `---
permission:
  request_payment: ask
---
`, true);
    const service = db.createService({
      kind: 'homework',
      name: 'ДЗ',
      categoryId: null,
      enabled: true,
      priceMin: 300,
      priceMax: 1500,
      instructions: '',
      model: '',
      previewEnabled: false,
      revisions: 1,
      agent: '',
    });
    const lead = db.addLead({
      projectId: 1,
      sourceId: null,
      tgChatId: 2,
      tgMessageId: 2,
      authorUserId: 1,
      authorName: 'B',
      authorUsername: null,
      text: 'x',
      date: Date.now(),
      link: null,
      score: 80,
      label: 'demand',
      reason: '',
    })!;
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: 2500 });
    expect(effectiveToolPermission(agent, 'request_payment', { orderId: order.id }, db)).toBe('allow');
    db.updateOrder(order.id, { price: 3500 });
    expect(effectiveToolPermission(agent, 'request_payment', { orderId: order.id }, db)).toBe('ask');
  });

  it('approval approve runs tool and continues dialog', async () => {
    const { db, engine, ai, manager, emit, lead, events } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    let paymentCalled = false;
    const service = db.createService({
      kind: 'homework',
      name: 'ДЗ',
      categoryId: null,
      enabled: true,
      priceMin: 300,
      priceMax: 1500,
      instructions: '',
      model: '',
      previewEnabled: false,
      revisions: 1,
      agent: '',
    });
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: 4000 });

    let operator!: ReturnType<typeof createOperator>;
    const host = () =>
      makeToolHost({
        db,
        engine,
        ai,
        emit,
        getSettings: () => db.getSettings(),
        orders: {
          applyManagerIntent: async () => {},
          requestPayment: async (id) => {
            paymentCalled = true;
            return db.updateOrder(id, { status: 'awaiting_payment' });
          },
        },
      });

    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => operator,
      runTool: ((tool, args, lid, an) => executeApprovedTool(tool, args, lid, an, host())) satisfies RunApprovedTool,
    });

    let turn = 0;
    operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      agents: defs,
      getApprovals: () => approvals,
      complete: async (msgs) => {
        turn++;
        if (turn === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '1', name: 'request_payment', arguments: JSON.stringify({ orderId: order.id }) }],
            },
            usageCostUsd: 0,
          };
        }
        const last = msgs[msgs.length - 1];
        expect(String(last.content)).toContain('Ссылка');
        return {
          message: { role: 'assistant', content: null, tool_calls: [{ id: '2', name: 'reply', arguments: JSON.stringify({ text: 'Счёт отправлен' }) }] },
          usageCostUsd: 0,
        };
      },
    });
    await operator.turn(lead.id);
    const pending = approvals.list('pending')[0];
    expect(pending.tool).toBe('request_payment');
    await approvals.decide(pending.id, true);
    expect(paymentCalled).toBe(true);
    expect(events.filter((e) => e.type === 'approval:update').length).toBeGreaterThan(1);
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('subagent and executor', () => {
  it('delegate runs subagent with prefixed trace', async () => {
    const { db, engine, ai, manager, emit, lead, events } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => ({ turn: async () => ({ reply: null, handoff: false, reason: '', steps: [] }) }),
      runTool: async () => 'ok',
    });
    const host = makeToolHost({ db, engine, ai, emit, getSettings: () => db.getSettings() });
    let calls = 0;
    const { text, steps } = await runSubagentTurn({
      agentName: 'researcher',
      task: 'найди 3 поставщика',
      context: 'Казань',
      leadId: lead.id,
      clientId: null,
      host,
      agents: defs,
      approvals,
      db,
      emit,
      complete: async () => {
        calls++;
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '1', name: 'web_search', arguments: JSON.stringify({ query: 'поставщики' }) }],
            },
            usageCostUsd: 0,
          };
        }
        return { message: { role: 'assistant', content: 'Итог исследования' }, usageCostUsd: 0 };
      },
    });
    expect(text).toContain('Итог');
    expect(steps.some((s) => s.tool.startsWith('researcher:'))).toBe(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('agent executor runs via subagent', async () => {
    const { db, emit, lead } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => ({ turn: async () => ({ reply: null, handoff: false, reason: '', steps: [] }) }),
      runTool: async () => 'ok',
    });
    const service = db.createService({
      kind: 'agent',
      name: 'Копирайт',
      categoryId: null,
      enabled: true,
      priceMin: 300,
      priceMax: 3000,
      instructions: 'тексты',
      model: '',
      previewEnabled: true,
      revisions: 1,
      agent: 'copywriter',
    });
    const order = db.createOrder(lead.id, service.id, 'пост для VK');
    const exec = createAgentExecutor({
      getSettings: () => db.getSettings(),
      agents: defs,
      approvals,
      db,
      emit,
      makeToolHost: () => makeToolHost({ db, emit, getSettings: () => db.getSettings(), engine: new FakeEngine(), ai: new FakeAi() }),
    });
    vi.spyOn(await import('../src/main/agent/subagent'), 'runSubagentTurn').mockResolvedValue({
      text: 'Готовый пост',
      steps: [],
    });
    const out = await exec.run({
      service,
      order,
      lead,
      history: [],
      inputs: [],
      workDir: dataDir,
      clientPhotoPath: null,
    });
    expect(out.text).toContain('Готовый пост');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('steps limit summary', () => {
  it('summarizes when steps exhausted without reply', async () => {
    const { db, engine, ai, manager, emit, lead } = setupDb();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-agents-'));
    const defs = createAgentDefs(dataDir, shipped);
    const m = defs.get('manager');
    defs.save({ ...m, steps: 1 });
    const approvals = createApprovals({
      db,
      emit,
      agents: defs,
      getOperator: () => operator,
      runTool: async () => 'ok',
    });
    let n = 0;
    let operator!: ReturnType<typeof createOperator>;
    operator = createOperator({
      db,
      engine,
      ai,
      manager,
      emit,
      getSettings: () => db.getSettings(),
      agents: defs,
      getApprovals: () => approvals,
      complete: async () => {
        n++;
        if (n === 1) {
          return {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: '1', name: 'search_memory', arguments: JSON.stringify({ query: 'x' }) }],
            },
            usageCostUsd: 0,
          };
        }
        return { message: { role: 'assistant', content: 'Осталось уточнить детали у клиента' }, usageCostUsd: 0 };
      },
    });
    const r = await operator.turn(lead.id);
    expect(r.reply).toContain('Осталось');
    rmSync(dataDir, { recursive: true, force: true });
  });
});

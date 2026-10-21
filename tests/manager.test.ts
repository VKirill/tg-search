import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiManagerAi } from '../src/main/ai/manager';
import { createApp } from '../src/main/app';
import { createManagerAgent } from '../src/main/pipeline/managerAgent';
import { createOperator } from '../src/main/agent/operator';
import { Db } from '../src/main/db';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager, FakeSpeech, makeMsg } from './fakes';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function testAppDeps() {
  return { speech: new FakeSpeech(), dataDir: mkdtempSync(join(tmpdir(), 'tg-test-')) };
}

function setupManager() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const ai = new FakeAi();
  const manager = new FakeManager();
  const events: import('../src/shared/types').AppEvent[] = [];
  const emit = (e: import('../src/shared/types').AppEvent) => events.push(e);
  const pipeline = { db, engine, ai, manager, emit };
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 'йога',
    offer: 'лендинги',
    criteria: '',
    sequence: [],
    manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 2, maxReplies: 3 },
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
    text: 'Нужен лендинг',
    date: Date.now(),
    link: 'https://t.me/anna/1',
    score: 90,
    label: 'demand',
    reason: '',
  })!;
  db.setSettings({ handoffNotifyTo: '@owner' });
  engine.resolveMap.set('@owner', { chatId: 777, title: 'Owner', username: 'owner', kind: 'private', memberCount: 1, description: '', isMember: true });
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
  return { db, engine, ai, manager, pipeline, events, acc, project, lead, operator };
}

describe('manager agent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('replies after delay and merges bursts', async () => {
    const { db, engine, pipeline, lead, operator } = setupManager();
    const agent = createManagerAgent({ ...pipeline, operator });
    agent.onIncoming(lead.id);
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(managerReplyCalls(pipeline)).toBe(1);
    expect(engine.sent).toHaveLength(1);
    agent.stop();
  });

  it('handoff notifies owner and stops further replies', async () => {
    const { db, engine, pipeline, lead, manager, operator } = setupManager();
    manager.replyResult = { reply: 'Передаю коллеге', handoff: true, reason: 'Созвон' };
    const agent = createManagerAgent({ ...pipeline, operator });
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.getLead(lead.id).handoff).toBe(true);
    expect(engine.posted).toHaveLength(1);
    expect(engine.posted[0].text).toContain('Передача диалога');
    manager.replyResult = { reply: 'ещё', handoff: false, reason: '' };
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.replyCalls).toBe(1);
    agent.stop();
  });

  it('maxReplies triggers handoff', async () => {
    const { db, pipeline, lead, acc, project, operator } = setupManager();
    db.updateProject(project.id, {
      manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 2, maxReplies: 1 },
    });
    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'in',
      where: 'dm',
      text: 'Привет',
      tgChatId: 500,
      tgMessageId: 1,
      date: Date.now() - 1000,
      auto: false,
    });
    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'out',
      where: 'dm',
      text: 'Ответ',
      tgChatId: 500,
      tgMessageId: 2,
      date: Date.now() - 500,
      auto: true,
    });
    const agent = createManagerAgent({ ...pipeline, operator });
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(2000);
    expect(db.getLead(lead.id).handoffReason).toBe('Лимит ответов ИИ');
    agent.stop();
  });
});

function managerReplyCalls(pipeline: { manager: FakeManager }) {
  return pipeline.manager.replyCalls;
}

describe('OpenAiManagerAi', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('uses project baseUrl and model override', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ choices: [{ message: { content: '{"reply":"ok","handoff":false,"reason":""}' } }] }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const settings = () => ({
      tgApiId: '',
      tgApiHash: '',
      llmBaseUrl: 'https://openrouter.ai/api/v1',
      llmApiKey: 'global',
      llmModel: 'global-model',
      jevBaseUrl: '',
      jevApiKey: '',
      jevModel: '',
      handoffNotifyTo: '',
      ownerName: 'Кирилл',
      sttBaseUrl: '',
      sttApiKey: '',
      sttModel: '',
      ttsBaseUrl: '',
      ttsApiKey: '',
      ttsModel: '',
      ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', newsInterests: '', operatorProvider: 'glm' as const, glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '', geminiApiKey: '', aiProviders: '[]', aiMainModel: '', aiHelperModels: '[]', aiUseFree: '1', aiVerifierModel: '', helperChats: '[]', helperDailyPerUser: '5', helperPauseSec: '5',
    });
    const ai = new OpenAiManagerAi(settings);
    const project = {
      id: 1,
      name: 'P',
      task: 'clients' as const,
      target: 't',
      offer: 'o',
      criteria: '',
      sequence: [],
      manager: {
        ...DEFAULT_MANAGER,
        baseUrl: 'https://custom.example/v1',
        apiKey: 'proj-key',
        model: 'custom/model',
      },
      geo: [],
      languages: ['ru'],
      accountIds: [],
      materials: [],
      keywords: [],
      agent: '',
      autopilot: { enabled: false, refreshSources: false, scanIntervalMin: 60, freshnessHours: 24, workingListSize: 10, aiReply: false, replyTarget: 'dm' as const, replyInNewSources: false, joinIfNeeded: false, minScore: 80, lastRunAt: null, nextRunAt: null },
      createdAt: 0,
    };
    const lead = {
      id: 1,
      projectId: 1,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 1,
      authorName: 'A',
      authorUsername: null,
      text: 'hi',
      date: 0,
      link: null,
      score: 80,
      label: 'demand' as const,
      reason: '',
      feedback: null,
      status: 'dialog' as const,
      accountId: null,
      clientId: null,
      repeatCount: 0,
      spamTemplateId: null,
      categoryId: null,
      sequenceStep: 0,
      nextStepAt: null,
      handoff: false,
      handoffReason: null,
      createdAt: 0,
    };
    await ai.reply(project, lead, [{ direction: 'in', text: 'hi' }]);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1]?.body));
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://custom.example/v1/chat/completions');
    expect(body.model).toBe('custom/model');
  });
});

describe('manager.test API', () => {
  it('returns parsed manager reply', async () => {
    const { db, engine, manager } = setupManager();
    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager,
      emit: () => {},
      openExternal: async () => {},
      ...testAppDeps(),
    });
    manager.replyResult = { reply: 'Тест', handoff: false, reason: '' };
    const project = db.listProjects()[0];
    const result = await app.manager.test(project.id, 'Запрос', [{ direction: 'out', text: 'Мы пишем' }]);
    expect(result.reply).toBe('Тест');
  });
});

describe('app private message', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('wires manager on incoming dm', async () => {
    const { db, engine, manager, acc, lead } = setupManager();
    const events: import('../src/shared/types').AppEvent[] = [];
    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager,
      emit: (e) => events.push(e),
      openExternal: async () => {},
      ...testAppDeps(),
    });
    await app.start();
    engine.emitPrivate(acc.id, makeMsg(500, 10, 'Ответ лида', { senderUserId: lead.authorUserId! }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.replyCalls).toBeGreaterThan(0);
    await app.stop();
  });

  it('after a restart, a dialog whose last word is the client\'s gets answered', async () => {
    const { db, engine, manager, lead } = setupManager();
    db.addMessage({ leadId: lead.id, accountId: null, direction: 'in', where: 'dm', kind: 'text', text: 'а 15 реши',
      tgChatId: 500, tgMessageId: 11, date: Date.now(), auto: false });
    const app = createApp({ db, engine, ai: new FakeAi(), manager, emit: () => {}, openExternal: async () => {}, ...testAppDeps() });
    await app.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.replyCalls).toBeGreaterThan(0);
    await app.stop();
  });
});

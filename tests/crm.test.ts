import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeAnamnesis, OpenAiCrmAi, stubCrmAi } from '../src/main/ai/crm';
import { emptyAnamnesis } from '../src/main/ai/crm';
import { createCrm, canAdvanceStage, suggestStageFromDialog, resolveStage } from '../src/main/pipeline/crm';
import { createManagerAgent } from '../src/main/pipeline/managerAgent';
import { OpenAiManagerAi } from '../src/main/ai/manager';
import { createApp } from '../src/main/app';
import { Db } from '../src/main/db';
import { DEFAULT_MANAGER } from '../src/shared/types';
import type { Anamnesis, ClientCard, Lead, Project } from '../src/shared/types';
import type { CrmAi, CrmAnalyzeResult, CrmTimelineLine } from '../src/main/ai/crm';
import { FakeAi, FakeEngine, FakeManager, FakeSpeech } from './fakes';

class FakeCrmAi implements CrmAi {
  analyzeCalls = 0;
  briefCalls = 0;
  analyzeResult: CrmAnalyzeResult = {
    summary: 'Саммари',
    anamnesis: emptyAnamnesis(),
    completeness: 50,
  };
  briefText = '# ТЗ\n\nТест';

  async analyze(
    _project: Project,
    _lead: Lead,
    _timeline: CrmTimelineLine[],
    card: ClientCard,
  ): Promise<CrmAnalyzeResult> {
    this.analyzeCalls++;
    const merged = mergeAnamnesis(card.anamnesis, this.analyzeResult.anamnesis);
    return {
      ...this.analyzeResult,
      anamnesis: merged,
    };
  }

  async writeBrief(): Promise<string> {
    this.briefCalls++;
    return this.briefText;
  }
}

function setupCrm() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const ai = new FakeAi();
  const crmAi = new FakeCrmAi();
  const events: import('../src/shared/types').AppEvent[] = [];
  const emit = (e: import('../src/shared/types').AppEvent) => events.push(e);
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 'йога',
    offer: 'сайты',
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
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
    text: 'Нужен сайт',
    date: Date.now(),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
  const crm = createCrm({ db, crmAi, emit });
  return { db, engine, ai, crmAi, crm, emit, events, acc, project, lead };
}

describe('mergeAnamnesis', () => {
  it('keeps known facts when the model returns empty fields', () => {
    const prev: Anamnesis = {
      task: 'Сайт студии',
      goal: 'запись онлайн',
      audience: 'йога',
      features: ['расписание'],
      integrations: ['ЮKassa'],
      stack: [],
      deadline: 'месяц',
      budget: '150 тыс',
      references: [],
      contacts: '',
      openQuestions: ['хостинг?'],
    };
    const next = mergeAnamnesis(prev, { task: '', budget: '', features: ['оплата'] });
    expect(next.task).toBe('Сайт студии');
    expect(next.budget).toBe('150 тыс');
    expect(next.features).toEqual(['расписание', 'оплата']);
    expect(next.openQuestions).toEqual(['хостинг?']);
  });
});

describe('stage rules', () => {
  it('advances forward only and respects manual stages', () => {
    expect(canAdvanceStage('new', 'contacted')).toBe(true);
    expect(canAdvanceStage('contacted', 'new')).toBe(false);
    expect(canAdvanceStage('proposal', 'won')).toBe(false);
    expect(resolveStage('proposal', 'brief_ready')).toBe('proposal');
  });

  it('suggests stages from dialog', () => {
    const lead = { handoff: false } as Lead;
    expect(suggestStageFromDialog(lead, [], false)).toBe('new');
    expect(
      suggestStageFromDialog(
        lead,
        [{ direction: 'out', kind: 'text' } as import('../src/shared/types').ChatMessage],
        false,
      ),
    ).toBe('contacted');
    expect(
      suggestStageFromDialog(
        lead,
        [{ direction: 'in', kind: 'text' } as import('../src/shared/types').ChatMessage],
        false,
      ),
    ).toBe('discovery');
  });
});

describe('createCrm', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces onMessage refresh', async () => {
    const { db, crm, crmAi, acc, lead } = setupCrm();
    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'in',
      where: 'dm',
      text: 'Привет',
      tgChatId: 1,
      tgMessageId: 1,
      date: Date.now(),
      auto: false,
    });
    crm.onMessage(db.listMessages(lead.id)[0]);
    crm.onMessage(db.listMessages(lead.id)[0]);
    expect(crmAi.analyzeCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(crmAi.analyzeCalls).toBe(1);
    crm.stop();
  });

  it('generateBrief sets stage brief_ready', async () => {
    const { db, crm, lead } = setupCrm();
    await crm.generateBrief(lead.id);
    const card = db.getCard(lead.id);
    expect(card.stage).toBe('brief_ready');
    expect(card.brief).toContain('ТЗ');
    crm.stop();
  });

  it('handoff triggers brief pipeline once', async () => {
    const { db, crm, crmAi, lead } = setupCrm();
    const updated = db.updateLead(lead.id, { handoff: true });
    crm.onLeadUpdate(updated);
    await vi.waitFor(() => expect(crmAi.briefCalls).toBe(1));
    expect(crmAi.analyzeCalls).toBeGreaterThanOrEqual(1);
    crm.stop();
  });
});

describe('manager + crm', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes card with open questions to manager reply', async () => {
    const { db, engine, ai, crmAi, crm, emit, acc, project, lead } = setupCrm();
    db.updateCard(lead.id, {
      anamnesis: {
        ...emptyAnamnesis(),
        task: 'Лендинг',
        openQuestions: ['Какой бюджет?'],
      },
      completeness: 40,
    });
    const manager = new FakeManager();
    const agent = createManagerAgent({ db, engine, ai, manager, emit, crm });
    db.updateProject(project.id, {
      manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 1 },
    });
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.lastCard?.anamnesis.openQuestions).toContain('Какой бюджет?');
    agent.stop();
    crm.stop();
  });

  it('handoff notification includes card summary', async () => {
    const { db, engine, ai, crmAi, crm, emit, acc, project, lead } = setupCrm();
    db.setSettings({ handoffNotifyTo: '@owner' });
    engine.resolveMap.set('@owner', {
      chatId: 777,
      title: 'Owner',
      username: 'owner',
      kind: 'private',
      memberCount: 1,
      description: '',
      isMember: true,
    });
    crmAi.analyzeResult = {
      summary: 'Клиент хочет сайт с оплатой',
      anamnesis: { ...emptyAnamnesis(), task: 'Сайт', budget: '150к' },
      completeness: 80,
    };
    const manager = new FakeManager();
    manager.replyResult = { reply: 'Передаю', handoff: true, reason: 'Готово' };
    const agent = createManagerAgent({ db, engine, ai, manager, emit, crm });
    db.updateProject(project.id, {
      manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 1 },
    });
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(engine.posted.length).toBe(1));
    expect(engine.posted[0].text).toContain('Клиент хочет сайт');
    expect(engine.posted[0].text).toContain('ТЗ готово в карточке клиента');
    agent.stop();
    crm.stop();
  });
});

describe('OpenAiManagerAi card context', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('includes open questions in the request body', async () => {
    const fetchMock = vi.fn(async () => ({
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
      llmApiKey: 'key',
      llmModel: 'm',
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
      ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '',
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
      manager: DEFAULT_MANAGER,
      geo: [],
      languages: ['ru'],
      accountIds: [],
      materials: [],
      keywords: [],
      autopilot: {
        enabled: false,
        refreshSources: false,
        scanIntervalMin: 60,
        freshnessHours: 24,
        workingListSize: 10,
        aiReply: false,
        replyTarget: 'dm' as const,
        replyInNewSources: false,
        joinIfNeeded: false,
        minScore: 80,
        lastRunAt: null,
        nextRunAt: null,
      },
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
      sequenceStep: 0,
      nextStepAt: null,
      handoff: false,
      handoffReason: null,
      createdAt: 0,
    };
    const card: ClientCard = {
      leadId: 1,
      stage: 'discovery',
      summary: '',
      anamnesis: { ...emptyAnamnesis(), openQuestions: ['Бюджет?'] },
      brief: '',
      notes: '',
      completeness: 30,
      updatedAt: 0,
      briefUpdatedAt: null,
    };
    await ai.reply(project, lead, [{ direction: 'in', text: 'hi' }], undefined, card);
    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(String((fetchMock.mock.calls[0] as any)[1].body));
    expect(body.messages[0].content).toContain('Бюджет?');
  });
});

describe('stubCrmAi', () => {
  it('throws when CRM AI is not configured', async () => {
    const stub = stubCrmAi();
    await expect(
      stub.analyze({} as Project, {} as Lead, [], {
        leadId: 1,
        stage: 'new',
        summary: '',
        anamnesis: emptyAnamnesis(),
        brief: '',
        notes: '',
        completeness: 0,
        updatedAt: 0,
        briefUpdatedAt: null,
      }),
    ).rejects.toThrow('CRM-ИИ не настроен');
  });
});

describe('app crm api', () => {
  it('refresh via API updates card', async () => {
    const { db, engine, crmAi } = setupCrm();
    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      crmAi,
      speech: new FakeSpeech(),
      dataDir: '/tmp/tg-search-crm-test',
      emit: () => {},
      openExternal: async () => {},
    });
    const lead = db.listLeads(db.listProjects()[0].id)[0];
    crmAi.analyzeResult.summary = 'Обновлено';
    const card = await app.crm.refresh(lead.id);
    expect(card.summary).toBe('Обновлено');
  });
});

describe('OpenAiCrmAi parse', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('merges anamnesis from LLM json', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: 'Итог',
                completeness: 70,
                anamnesis: { task: 'Новая задача', budget: '' },
              }),
            },
          },
        ],
      }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const settings = () => ({
      tgApiId: '',
      tgApiHash: '',
      llmBaseUrl: 'https://openrouter.ai/api/v1',
      llmApiKey: 'key',
      llmModel: 'm',
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
      ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '',
    });
    const ai = new OpenAiCrmAi(settings);
    const card: ClientCard = {
      leadId: 1,
      stage: 'new',
      summary: '',
      anamnesis: { ...emptyAnamnesis(), task: 'Старый сайт', budget: '100к' },
      brief: '',
      notes: '',
      completeness: 0,
      updatedAt: 0,
      briefUpdatedAt: null,
    };
    const result = await ai.analyze(
      { offer: 'x', name: 'P' } as Project,
      { text: 'запрос', authorName: 'A' } as Lead,
      [{ label: 'Клиент', text: 'запрос' }],
      card,
    );
    expect(result.anamnesis.task).toBe('Новая задача');
    expect(result.anamnesis.budget).toBe('100к');
  });
});

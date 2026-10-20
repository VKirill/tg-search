import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { createAutopilot } from '../src/main/pipeline/autopilot';
import { sendMessage } from '../src/main/pipeline/outreach';
import {
  fillSequenceTemplate,
  processDueSteps,
  shortRequestQuote,
} from '../src/main/pipeline/sequence';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager } from './fakes';

function setup() {
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
    target: 'buyers',
    offer: 'dev',
    criteria: '',
    sequence: [
      { delayHours: 0, mode: 'template', text: 'Привет, {name}! По поводу: {request}' },
      { delayHours: 1, mode: 'template', text: 'Напоминаю про {request}' },
      { delayHours: 2, mode: 'template', text: 'Последнее касание' },
    ],
    manager: DEFAULT_MANAGER,
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: [],
  });
  return { db, engine, ai, manager, pipeline, events, acc, project };
}

function addLead(db: Db, projectId: number, authorUserId: number) {
  return db.addLead({
    projectId,
    sourceId: null,
    tgChatId: 1,
    tgMessageId: authorUserId,
    authorUserId,
    authorName: 'Иван Петров',
    authorUsername: 'ivan',
    text: 'Нужен сайт для йога-студии срочно завтра',
    date: Date.now(),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
}

describe('sequence templates', () => {
  it('fills name and request quote', () => {
    const { db, project } = setup();
    const lead = addLead(db, project.id, 10);
    const filled = fillSequenceTemplate('Hi {name}, re {request}', lead);
    expect(filled).toContain('Иван');
    expect(filled).toContain('йога');
    const q = shortRequestQuote('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen');
    expect(q.length).toBeLessThanOrEqual(80);
  });
});

describe('chain lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts chain on manual first send', async () => {
    const { db, pipeline, project } = setup();
    const lead = addLead(db, project.id, 11);
    await sendMessage(pipeline, lead.id, 'Первое', 'dm');
    const updated = db.getLead(lead.id);
    expect(updated.sequenceStep).toBe(1);
    expect(updated.nextStepAt).not.toBeNull();
  });

  it('sends follow-up while silent and stops on reply', async () => {
    const { db, engine, pipeline, project, acc } = setup();
    const lead = addLead(db, project.id, 12);
    const t0 = Date.parse('2026-01-01T12:00:00Z');
    vi.setSystemTime(t0);
    await sendMessage(pipeline, lead.id, 'Шаг0', 'dm');
    const dueAt = db.getLead(lead.id).nextStepAt!;
    vi.setSystemTime(dueAt + 1000);
    await processDueSteps(pipeline, dueAt + 1000);
    expect(engine.sent).toHaveLength(2);
    expect(engine.sent[1].text).toContain('Напоминаю');

    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'in',
      where: 'dm',
      text: 'Спасибо, интересно',
      tgChatId: 12,
      tgMessageId: 99,
      date: dueAt + 2000,
      auto: false,
    });
    db.updateLead(lead.id, { status: 'dialog', nextStepAt: dueAt + 5000 });
    vi.setSystemTime(dueAt + 10_000);
    await processDueSteps(pipeline, dueAt + 10_000);
    expect(engine.sent).toHaveLength(2);
  });

  it('keeps nextStepAt on limiter refusal', async () => {
    const { db, pipeline, project, acc } = setup();
    const lead = addLead(db, project.id, 13);
    const t0 = Date.parse('2026-01-01T12:00:00Z');
    vi.setSystemTime(t0);
    await sendMessage(pipeline, lead.id, 'Шаг0', 'dm');
    const dueAt = db.getLead(lead.id).nextStepAt!;
    db.updateAccount(acc.id, { sentToday: 10, sentDay: '2026-01-01' });
    vi.setSystemTime(dueAt + 1000);
    await processDueSteps(pipeline, dueAt + 1000);
    expect(db.getLead(lead.id).nextStepAt).toBe(dueAt);
  });

  it('clears chain on send error', async () => {
    const { db, engine, pipeline, project, events } = setup();
    const lead = addLead(db, project.id, 14);
    const t0 = Date.parse('2026-01-01T12:00:00Z');
    vi.setSystemTime(t0);
    await sendMessage(pipeline, lead.id, 'Шаг0', 'dm');
    const dueAt = db.getLead(lead.id).nextStepAt!;
    engine.sendDirect = async () => {
      throw new Error('blocked');
    };
    vi.setSystemTime(dueAt + 1000);
    await processDueSteps(pipeline, dueAt + 1000);
    expect(db.getLead(lead.id).nextStepAt).toBeNull();
    expect(events.some((e) => e.type === 'job')).toBe(true);
  });

  it('autopilot uses sequence step 0', async () => {
    const { db, engine, pipeline, project } = setup();
    db.updateProject(project.id, {
      autopilot: { enabled: true, aiReply: true, minScore: 50, replyTarget: 'dm' },
    });
    addLead(db, project.id, 15);
    const ap = createAutopilot(pipeline);
    await ap.run(project.id);
    await ap.tick();
    expect(engine.sent[0].text).toContain('Иван');
    expect(pipeline.manager.writeStepCalls).toBe(0);
  });
});

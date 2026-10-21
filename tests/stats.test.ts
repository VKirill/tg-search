import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { categorizeLeads, qualifyAndAddLeads } from '../src/main/pipeline/scanner';
import { buildReport } from '../src/main/pipeline/stats';
import { todayLocal } from '../src/main/pipeline/limiter';
import { recordUsage, setUsageSink } from '../src/main/usage';
import type { Categorizer, Classification } from '../src/main/ai/types';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, makeMsg } from './fakes';

class FakeCategorizer implements Categorizer {
  calls = 0;
  constructor(private readonly probs: Record<number, number>, private readonly fail = false) {}
  async classify(_c: unknown, messages: { chatId: number; messageId: number }[]): Promise<Classification[]> {
    this.calls++;
    if (this.fail) throw new Error('jev down');
    return messages.map((m) => ({ key: `${m.chatId}:${m.messageId}`, categoryId: 1, categoryProb: 0.9, requestProb: this.probs[m.messageId] ?? 0 }));
  }
}

function setup(categorizer: Categorizer) {
  const db = new Db(':memory:');
  const ai = new FakeAi();
  const project = db.createProject({
    name: 'P', task: 'clients', target: 't', offer: 'o', criteria: '', sequence: [], manager: DEFAULT_MANAGER,
    geo: [], languages: [], accountIds: [], materials: [], keywords: [],
  });
  const deps = { db, engine: new FakeEngine(), ai, emit: () => {}, categorizer };
  return { db, ai, project, deps };
}

describe('demand map gate', () => {
  it('qualifies only probable requests and classifies each message once', async () => {
    const cat = new FakeCategorizer({ 1: 0.05, 2: 0.9 });
    const { db, ai, project, deps } = setup(cat);
    let qualified: number[] = [];
    ai.qualify = async (_p, msgs) => {
      qualified = msgs.map((m) => m.messageId);
      return [];
    };
    const msgs = [makeMsg(10, 1, 'привет всем, как дела у вас тут'), makeMsg(10, 2, 'нужен телеграм-бот для записи клиентов')];
    await qualifyAndAddLeads(deps, project, 1, msgs);
    expect(qualified).toEqual([2]);
    await qualifyAndAddLeads(deps, project, 1, msgs);
    expect(cat.calls).toBe(1); // already classified
    expect(db.requestProbs(msgs).size).toBe(2);
  });

  it('fails open when the categorizer is down', async () => {
    const { ai, project, deps } = setup(new FakeCategorizer({}, true));
    let qualified = 0;
    ai.qualify = async (_p, msgs) => {
      qualified = msgs.length;
      return [];
    };
    await qualifyAndAddLeads(deps, project, 1, [makeMsg(10, 3, 'нужен сайт для студии йоги'), makeMsg(10, 4, 'ищу дизайнера логотипа')]);
    expect(qualified).toBe(2);
  });

  it('labels each lead with the category of its message', async () => {
    const { db, ai, project, deps } = setup(new FakeCategorizer({ 5: 0.9 }));
    ai.qualify = async (_p, msgs) => msgs.map((m) => ({ key: `${m.chatId}:${m.messageId}`, score: 90, label: 'demand' as const, reason: '' }));
    const src = db.addSource({
      projectId: project.id, tgChatId: 10, title: 'Чат', username: null, kind: 'group', memberCount: 100,
      foundBy: 'manual', accountId: null, status: 'active',
    });
    await qualifyAndAddLeads(deps, project, src.id, [makeMsg(10, 5, 'нужен лендинг для кофейни')]);
    const [lead] = db.listLeads(project.id);
    expect(lead.categoryId).toBe(1);
    db.removeCategory(1);
    expect(db.getLead(lead.id).categoryId).toBeNull();
  });

  it('categorizes old leads that were never classified', async () => {
    const cat = new FakeCategorizer({});
    const { db, project } = setup(cat);
    const src = db.addSource({
      projectId: project.id, tgChatId: 11, title: 'Чат', username: null, kind: 'group', memberCount: 100,
      foundBy: 'manual', accountId: null, status: 'active',
    });
    const lead = db.addLead({
      projectId: project.id, sourceId: src.id, tgChatId: 11, tgMessageId: 1, authorUserId: 1, authorName: 'A',
      authorUsername: null, text: 'настройте Яндекс Директ для салона', date: Date.now(), link: null, score: 90,
      label: 'demand', reason: '',
    })!;
    expect(lead.categoryId).toBeNull();
    const updates: number[] = [];
    expect(await categorizeLeads({ db, emit: (e) => e.type === 'lead:update' && updates.push(e.lead.id) }, cat)).toBe(1);
    expect(db.getLead(lead.id).categoryId).toBe(1);
    expect(updates).toEqual([lead.id]);
    await categorizeLeads({ db, emit: () => {} }, cat);
    expect(cat.calls).toBe(1);
  });
});

describe('statistics', () => {
  it('builds per-day totals, spend by kind and the category map', () => {
    const db = new Db(':memory:');
    const day = todayLocal(Date.now());
    const add = (id: number, prob: number, categoryId: number | null) =>
      db.addClassified({ chatId: 1, messageId: id, day, date: Date.now(), categoryId, categoryProb: 0.9, requestProb: prob, text: `m${id}`, link: null });
    add(1, 0.9, 1);
    add(2, 0.1, 1);
    add(3, 0.05, null);
    db.addUsage({ day, kind: 'jev', model: 'jev-1.14.0', inputTokens: 1000, outputTokens: 10, units: 6, costUsd: 0.001 });
    db.addUsage({ day, kind: 'llm', model: 'm', inputTokens: 10, outputTokens: 10, units: 0, costUsd: 0.02 });
    const r = buildReport(db, 'week');
    expect(r.days).toHaveLength(7);
    expect(r.days[6].day).toBe(day);
    expect(r.totals).toMatchObject({ analyzed: 3, requests: 1, chatter: 2 });
    expect(r.totals.costByKind.jev).toBeCloseTo(0.001);
    expect(r.totals.costUsd).toBeCloseTo(0.021);
    const it = r.categories.find((c) => c.categoryId === 1)!;
    expect(it).toMatchObject({ name: 'Сайты и лендинги', messages: 2, requests: 1 });
    expect(it.examples.map((e) => e.text)).toEqual(['m1']);
  });

  it('prices Jev usage from settings', () => {
    const db = new Db(':memory:');
    setUsageSink((u) => db.addUsage(u), () => db.getSettings());
    recordUsage({ kind: 'jev', model: 'jev-1.14.0', inputTokens: 1_000_000 });
    expect(buildReport(db, 'day').totals.costByKind.jev).toBeCloseTo(0.042);
  });
});

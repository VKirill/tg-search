import { DEFAULT_MANAGER } from '../src/shared/types';
import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createApp } from '../src/main/app';
import { createAutopilot } from '../src/main/pipeline/autopilot';
import { discover } from '../src/main/pipeline/discovery';
import { scan } from '../src/main/pipeline/scanner';
import { sendMessage } from '../src/main/pipeline/outreach';
import { FakeAi, FakeEngine, makeChat, makeMsg } from './fakes';
import type { AppEvent } from '../src/shared/types';

function setupPipeline() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const ai = new FakeAi();
  const events: AppEvent[] = [];
  const emit = (e: AppEvent) => events.push(e);
  const pipeline = { db, engine, ai, emit };
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 'buyers',
    offer: 'dev',
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: ['keyword-one'],
  });
  return { db, engine, ai, emit, events, pipeline, acc, project };
}

describe('discovery', () => {
  it('adds sources, rates, limits active count and dedupes', async () => {
    const { db, engine, ai, pipeline, project } = setupPipeline();
    db.updateProject(project.id, { autopilot: { workingListSize: 1 } });
    const c1 = makeChat(101, 'Alpha');
    const c2 = makeChat(102, 'Beta');
    engine.searchChats = [c1, c2];
    engine.chats.set(101, c1);
    engine.chats.set(102, c2);
    engine.setHistory(101, []);
    engine.setHistory(102, []);
    ai.rateScore = 70;

    const sources = await discover(pipeline, project.id);
    expect(sources.filter((s) => s.status === 'active')).toHaveLength(1);
    expect(sources.filter((s) => s.status === 'candidate')).toHaveLength(1);

    ai.rateScore = 80;
    const again = await discover(pipeline, project.id);
    expect(again).toHaveLength(2);
  });
});

describe('scan', () => {
  it('skips seen messages on second run and qualifies once per message', async () => {
    const { db, engine, ai, pipeline, project, acc } = setupPipeline();
    const chat = makeChat(201);
    engine.chats.set(201, chat);
    const src = db.addSource({
      projectId: project.id,
      tgChatId: 201,
      title: chat.title,
      username: chat.username,
      kind: chat.kind,
      memberCount: 100,
      foundBy: 'manual',
      accountId: acc.id,
      status: 'active',
    });
    const msg = makeMsg(201, 1, 'Нужен разработчик на заказ срочно');
    engine.setHistory(201, [msg]);

    const r1 = await scan(pipeline, project.id);
    expect(r1.newLeads).toBe(1);
    expect(ai.qualifyCalls).toBe(1);

    const r2 = await scan(pipeline, project.id);
    expect(r2.newLeads).toBe(0);
    expect(ai.qualifyCalls).toBe(1);
    expect(db.getSource(src.id).lastScannedAt).not.toBeNull();
  });
});

describe('outreach', () => {
  it('picks account with capacity and throws Russian reason when exhausted', async () => {
    const { db, engine, pipeline, project, acc } = setupPipeline();
    const lead = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 999,
      authorName: 'A',
      authorUsername: 'a',
      text: 'hello',
      date: Date.now(),
      link: null,
      score: 80,
      label: 'demand',
      reason: 'x',
    })!;
    db.updateAccount(acc.id, { sentToday: 10, sentDay: new Date().toISOString().slice(0, 10) });
    await expect(sendMessage(pipeline, lead.id, 'hi', 'dm')).rejects.toThrow('Дневной лимит');

    db.updateAccount(acc.id, { sentToday: 0, sentDay: null });
    await sendMessage(pipeline, lead.id, 'hi', 'dm');
    expect(engine.sent).toHaveLength(1);
    expect(engine.sent[0].kind).toBe('dm');
  });

  it('fails dm without author', async () => {
    const { db, pipeline, project } = setupPipeline();
    const lead = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 2,
      authorUserId: null,
      authorName: null,
      authorUsername: null,
      text: 'post',
      date: Date.now(),
      link: null,
      score: 80,
      label: 'demand',
      reason: 'x',
    })!;
    await expect(sendMessage(pipeline, lead.id, 'hi', 'dm')).rejects.toThrow('Контакт не определён');
  });
});

describe('autopilot', () => {
  it('replies only to leads at or above minScore', async () => {
    const { db, engine, ai, pipeline, project, acc } = setupPipeline();
    db.updateProject(project.id, {
      autopilot: { enabled: true, aiReply: true, minScore: 80, replyTarget: 'dm' },
    });
    const low = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 10,
      authorUserId: 11,
      authorName: 'L',
      authorUsername: null,
      text: 'low',
      date: Date.now(),
      link: null,
      score: 50,
      label: 'demand',
      reason: '',
    })!;
    const high = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 11,
      authorUserId: 12,
      authorName: 'H',
      authorUsername: null,
      text: 'high',
      date: Date.now(),
      link: null,
      score: 90,
      label: 'demand',
      reason: '',
    })!;
    const ap = createAutopilot(pipeline);
    await ap.run(project.id);
    await ap.tick();
    expect(engine.sent).toHaveLength(1);
    expect(db.getLead(high.id).status).toBe('replied');
    expect(db.getLead(low.id).status).toBe('new');
    void acc;
  });

  it('respects daily limit across ticks', async () => {
    const { db, engine, pipeline, project, acc } = setupPipeline();
    db.updateAccount(acc.id, { dailyLimit: 1, pauseSec: 0 });
    db.updateProject(project.id, {
      autopilot: { enabled: true, aiReply: true, minScore: 50, replyTarget: 'dm' },
    });
    for (let i = 0; i < 2; i++) {
      db.addLead({
        projectId: project.id,
        sourceId: null,
        tgChatId: 1,
        tgMessageId: 20 + i,
        authorUserId: 100 + i,
        authorName: 'X',
        authorUsername: null,
        text: 'need dev',
        date: Date.now(),
        link: null,
        score: 90,
        label: 'demand',
        reason: '',
      });
    }
    const ap = createAutopilot(pipeline);
    await ap.run(project.id);
    await ap.tick();
    expect(engine.sent).toHaveLength(1);
    await ap.tick();
    expect(engine.sent).toHaveLength(1);
  });

  it('does not auto-reply to a queued lead the user already answered', async () => {
    const { db, engine, pipeline, project } = setupPipeline();
    db.updateProject(project.id, { autopilot: { enabled: true, aiReply: true, minScore: 50, replyTarget: 'dm' } });
    const lead = db.addLead({
      projectId: project.id, sourceId: null, tgChatId: 1, tgMessageId: 30, authorUserId: 200, authorName: 'M',
      authorUsername: null, text: 'need a bot', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
    })!;
    const ap = createAutopilot(pipeline);
    await ap.run(project.id); // queued
    await sendMessage(pipeline, lead.id, 'manual reply', 'dm');
    await ap.tick();
    expect(engine.sent.map((m) => m.text)).toEqual(['manual reply']);
  });

  it('does not retry a failed auto-reply', async () => {
    const { db, engine, pipeline, project, events } = setupPipeline();
    db.updateProject(project.id, { autopilot: { enabled: true, aiReply: true, minScore: 50, replyTarget: 'dm' } });
    db.addLead({
      projectId: project.id, sourceId: null, tgChatId: 1, tgMessageId: 31, authorUserId: 201, authorName: 'N',
      authorUsername: null, text: 'need a site', date: Date.now(), link: null, score: 90, label: 'demand', reason: '',
    });
    let attempts = 0;
    engine.sendDirect = async () => {
      attempts++;
      throw new Error('USER_PRIVACY_RESTRICTED');
    };
    const ap = createAutopilot(pipeline);
    await ap.run(project.id);
    await ap.tick();
    await ap.run(project.id);
    await ap.tick();
    expect(attempts).toBe(1);
    expect(events.some((e) => e.type === 'job' && e.error === 'USER_PRIVACY_RESTRICTED')).toBe(true);
  });

  it('retires weak sources on refresh', async () => {
    const { db, pipeline, project } = setupPipeline();
    const weak = db.addSource({
      projectId: project.id,
      tgChatId: 301,
      title: 'Weak',
      username: null,
      kind: 'channel',
      memberCount: 1,
      foundBy: 'x',
      accountId: null,
      status: 'active',
    });
    const good = db.addSource({
      projectId: project.id, tgChatId: 302, title: 'Busy', username: null, kind: 'supergroup', memberCount: 5000,
      foundBy: 'x', accountId: null, status: 'active',
    });
    db.bumpSourceStats(weak.id, 200, 1); // 0.5% leads
    db.bumpSourceStats(good.id, 200, 3); // 1.5% leads: a good busy chat
    db.updateProject(project.id, { autopilot: { refreshSources: true, workingListSize: 10 } });
    const ap = createAutopilot(pipeline);
    await ap.run(project.id);
    expect(db.getSource(weak.id).status).toBe('rejected');
    expect(db.getSource(good.id).status).toBe('active');
  });
});

describe('incoming private messages', () => {
  it('attaches to the newest lead by author', async () => {
    const { db, engine, emit, acc, project } = setupPipeline();
    const app = createApp({ db, engine, ai: new FakeAi(), emit, openExternal: async () => {} });
    await app.start();

    const older = db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 555,
      authorName: 'U',
      authorUsername: null,
      text: 'old',
      date: Date.now() - 10_000,
      link: null,
      score: 80,
      label: 'demand',
      reason: '',
    })!;
    db.addLead({
      projectId: project.id,
      sourceId: null,
      tgChatId: 2,
      tgMessageId: 2,
      authorUserId: 555,
      authorName: 'U',
      authorUsername: null,
      text: 'new',
      date: Date.now(),
      link: null,
      score: 80,
      label: 'demand',
      reason: '',
    });

    engine.emitPrivate(acc.id, makeMsg(555, 99, 'ответ клиента', { senderUserId: 555, chatId: 555 }));
    const msgs = db.listMessages(older.id);
    expect(msgs.some((m) => m.direction === 'in' && m.text === 'ответ клиента')).toBe(false);
    const leads = db.findLeadsByAuthor(555);
    const newest = leads[0];
    expect(db.listMessages(newest.id).some((m) => m.direction === 'in')).toBe(true);
    expect(db.getLead(newest.id).status).toBe('dialog');
    await app.stop();
  });
});

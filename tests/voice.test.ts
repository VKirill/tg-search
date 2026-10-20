import { todayLocal } from '../src/main/pipeline/limiter';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/main/app';
import { Db } from '../src/main/db';
import { createManagerAgent } from '../src/main/pipeline/managerAgent';
import { sendVoiceMessage } from '../src/main/pipeline/outreach';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager, FakeSpeech, makeMsg } from './fakes';
import { VOICE_TRANSCRIPT_FAILED } from '../src/main/voice/incoming';

function setupVoice() {
  const db = new Db(':memory:');
  const engine = new FakeEngine();
  const ai = new FakeAi();
  const speech = new FakeSpeech();
  const manager = new FakeManager();
  const dataDir = mkdtempSync(join(tmpdir(), 'tg-voice-'));
  const events: import('../src/shared/types').AppEvent[] = [];
  const emit = (e: import('../src/shared/types').AppEvent) => events.push(e);
  const pipeline = { db, engine, ai, speech, manager, emit };
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 10, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 't',
    offer: 'o',
    criteria: '',
    sequence: [],
    manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 1, voiceReplies: 'mirror' },
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
  return { db, engine, ai, speech, manager, pipeline, events, acc, project, lead, dataDir };
}

describe('incoming voice in DM', () => {
  it('stores kind voice with transcript and runs manager on text', async () => {
    const { db, engine, speech, manager, acc, lead, dataDir } = setupVoice();
    const voiceFile = join(dataDir, 'tg.ogg');
    writeFileSync(voiceFile, 'voice-bytes');
    engine.files.set(42, voiceFile);
    speech.transcribeResult = 'нужен лендинг голосом';

    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager,
      speech,
      dataDir,
      emit: () => {},
      openExternal: async () => {},
    });
    await app.start();
    engine.emitPrivate(
      acc.id,
      makeMsg(500, 10, '', {
        senderUserId: lead.authorUserId!,
        voice: { fileId: 42, durationSec: 5 },
      }),
    );
    let msg: import('../src/shared/types').ChatMessage | undefined;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      msg = db.listMessages(lead.id).find((m) => m.kind === 'voice');
      if (msg) break;
    }
    expect(msg?.text).toBe('нужен лендинг голосом');
    expect(msg?.mediaPath).toBeTruthy();
    await vi.waitFor(() => manager.replyCalls > 0, { timeout: 3000 });
    await app.stop();
  });

  it('stores placeholder on transcription failure and emits job error', async () => {
    const { db, engine, speech, acc, lead, dataDir, events } = setupVoice();
    const voiceFile = join(dataDir, 'tg.ogg');
    writeFileSync(voiceFile, 'voice-bytes');
    engine.files.set(43, voiceFile);
    speech.transcribe = async () => {
      throw new Error('stt down');
    };

    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager: new FakeManager(),
      speech,
      dataDir,
      emit: (e) => events.push(e),
      openExternal: async () => {},
    });
    await app.start();
    engine.emitPrivate(
      acc.id,
      makeMsg(500, 11, '', {
        senderUserId: lead.authorUserId!,
        voice: { fileId: 43, durationSec: 4 },
      }),
    );
    let msg: import('../src/shared/types').ChatMessage | undefined;
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
      msg = db.listMessages(lead.id).find((m) => m.text === VOICE_TRANSCRIPT_FAILED);
      if (msg) break;
    }
    expect(msg?.kind).toBe('voice');
    expect(events.some((e) => e.type === 'job' && e.error?.includes('stt'))).toBe(true);
    await app.stop();
  });
});

describe('sendVoiceMessage', () => {
  it('uses limiter and stores kind voice', async () => {
    const { db, engine, speech, pipeline, lead, acc } = setupVoice();
    db.updateAccount(acc.id, { sentToday: 10, sentDay: todayLocal(Date.now()) });
    await expect(sendVoiceMessage(pipeline, lead.id, 'Привет', 'dm')).rejects.toThrow('Дневной лимит');

    db.updateAccount(acc.id, { sentToday: 0, sentDay: null });
    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'in',
      where: 'dm',
      text: 'вопрос',
      tgChatId: 500,
      tgMessageId: 9,
      date: Date.now() - 100,
      auto: false,
    });
    const msg = await sendVoiceMessage(pipeline, lead.id, 'Голосовой ответ', 'dm');
    expect(msg.kind).toBe('voice');
    expect(msg.text).toBe('Голосовой ответ');
    expect(engine.voiceSent).toHaveLength(1);
    expect(speech.synthesizeCalls).toContain('Голосовой ответ');
  });
});

describe('voice DM target', () => {
  it('goes to the private chat even when an owner note sits in the dialog', async () => {
    const { db, engine, pipeline, lead } = setupVoice();
    // Notes are stored with where 'dm' and the lead's group chat id; they must not decide where DMs go.
    db.addMessage({
      leadId: lead.id, accountId: null, direction: 'out', where: 'dm', kind: 'note', text: 'заметка',
      tgChatId: lead.tgChatId, tgMessageId: null, date: Date.now(), auto: false,
    });
    await sendVoiceMessage(pipeline, lead.id, 'Голосовой ответ', 'dm');
    expect(engine.voiceSent[0].chatId).toBe(lead.authorUserId);
  });
});

describe('manager mirror voice', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends voice when last inbound was voice', async () => {
    const { db, engine, pipeline, lead, acc } = setupVoice();
    db.addMessage({
      leadId: lead.id,
      accountId: acc.id,
      direction: 'in',
      where: 'dm',
      kind: 'voice',
      text: 'вопрос голосом',
      mediaPath: '/x.ogg',
      durationSec: 2,
      tgChatId: 500,
      tgMessageId: 1,
      date: Date.now() - 1000,
      auto: false,
    });
    const agent = createManagerAgent(pipeline);
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.voiceSent).toHaveLength(1);
    expect(engine.sent).toHaveLength(0);
    agent.stop();
  });
});

describe('calls.save', () => {
  it('stores kind call with transcript', async () => {
    const { db, engine, speech, lead, dataDir } = setupVoice();
    speech.transcribeResult = 'обсудили сроки и бюджет';
    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager: new FakeManager(),
      speech,
      dataDir,
      emit: () => {},
      openExternal: async () => {},
    });
    const audio = new Uint8Array([0, 1, 2, 3]);
    const msg = await app.calls.save(lead.id, audio, 'audio/webm', 120);
    expect(msg.kind).toBe('call');
    expect(msg.text).toBe('обсудили сроки и бюджет');
    expect(msg.mediaPath).toContain(`call-${lead.id}`);
    expect(msg.durationSec).toBe(120);
  });
});

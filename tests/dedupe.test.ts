import { describe, expect, it, vi } from 'vitest';
import { Db } from '../src/main/db';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { createDedupe, pruneFingerprints } from '../src/main/dedupe';
import { fingerprintText, isNearDuplicate } from '../src/main/dedupe/fingerprint';
import { normalizeMessageText } from '../src/main/dedupe/normalize';
import { qualifyAndAddLeads } from '../src/main/pipeline/scanner';
import { FakeAi, makeMsg } from './fakes';
import type { Categorizer } from '../src/main/ai/types';
import type { AppEvent } from '../src/shared/types';

const BAIT =
  'Всем привет! Нужно помочь с парой карточек. Оплата по результату. Пишите в личку — объясню все подробности 😊';

function homoglyphBait(): string {
  return 'Вceм пpивет! Нужнo пoмoчь c пapoй кapтoчeк. Oплата пo peзультату. Пишите в личку — oбъясню всe пoдpoбнocти';
}

function setup() {
  const db = new Db(':memory:');
  const events: AppEvent[] = [];
  const dedupe = createDedupe({ db, emit: (e) => events.push(e) });
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized' });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 't',
    offer: 'o',
    criteria: 'lead',
    sequence: [],
    manager: DEFAULT_MANAGER,
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: [],
  });
  const source = db.addSource({
    projectId: project.id,
    tgChatId: 100,
    title: 'Chat',
    username: null,
    kind: 'supergroup',
    memberCount: 10,
    foundBy: 'manual',
    accountId: acc.id,
    status: 'active',
  });
  const ai = new FakeAi();
  return { db, dedupe, project, source, ai, events };
}

describe('normalize + fingerprint', () => {
  it('collapses bait homoglyphs, emoji and spacing to one fingerprint', () => {
    const variants = [
      BAIT,
      homoglyphBait(),
      BAIT.replace('привет', 'привет!!!'),
      BAIT + '\u200B\u200C',
      BAIT.replace('😊', '🔥✨'),
    ];
    const fps = variants.map((t) => fingerprintText(t));
    for (let i = 1; i < fps.length; i++) {
      expect(isNearDuplicate(fps[0], fps[i])).toBe(true);
    }
    expect(fps[0].exactHash).toBe(fps[1].exactHash);
    expect(fps[0].exactHash).toBe(fps[2].exactHash);
  });

  it('strips urls and mentions but keeps core text', () => {
    const n = normalizeMessageText('Привет @user123 смотри https://example.com/x заказ');
    expect(n.mentions).toEqual(['@user123']);
    expect(n.urls.length).toBe(1);
    expect(n.text).toContain('привет');
    expect(n.text).toContain('заказ');
    expect(n.text).not.toContain('http');
    expect(n.text).not.toContain('@');
  });
});

describe('dedupe pipeline', () => {
  it('same author ×10 → one lead with repeat_count 9', async () => {
    const { db, dedupe, project, source, ai } = setup();
    const pipeline = { db, engine: {} as never, ai, emit: () => {}, dedupe };
    const base = Date.now();
    for (let i = 0; i < 10; i++) {
      const msg = makeMsg(100, i + 1, BAIT, { senderUserId: 42, date: base + i * 1000 });
      await qualifyAndAddLeads(pipeline, project, source.id, [msg]);
    }
    const leads = db.listLeads(project.id, { status: 'all' });
    expect(leads).toHaveLength(1);
    expect(leads[0].repeatCount).toBe(9);
    expect(ai.qualifyCalls).toBe(1);
  });

  it('three authors → spam template and hidden leads', async () => {
    const { db, dedupe, project, source, ai } = setup();
    const pipeline = { db, engine: {} as never, ai, emit: () => {}, dedupe };
    for (let u = 1; u <= 3; u++) {
      const msg = makeMsg(100, u, homoglyphBait(), { senderUserId: 1000 + u });
      await qualifyAndAddLeads(pipeline, project, source.id, [msg]);
    }
    const templates = dedupe.listTemplates();
    expect(templates.some((t) => t.status === 'spam' && t.source === 'auto')).toBe(true);
    const leads = db.listLeads(project.id, { status: 'all' });
    expect(leads.every((l) => l.status === 'hidden')).toBe(true);
    expect(leads.every((l) => l.spamTemplateId != null)).toBe(true);
  });

  it('owner markSpam hides look-alike leads', async () => {
    const { db, dedupe, project, source, ai, events } = setup();
    const pipeline = { db, engine: {} as never, ai, emit: (e: AppEvent) => events.push(e), dedupe };
    const msg1 = makeMsg(100, 1, BAIT, { senderUserId: 1 });
    await qualifyAndAddLeads(pipeline, project, source.id, [msg1]);
    const lead = db.listLeads(project.id, { status: 'all' })[0];
    dedupe.markSpam(lead.id);
    const msg2 = makeMsg(101, 2, homoglyphBait(), { senderUserId: 2 });
    await qualifyAndAddLeads(pipeline, project, source.id, [msg2]);
    expect(db.listLeads(project.id, { status: 'all' }).every((l) => l.status === 'hidden')).toBe(true);
  });

  it('allowed template stops auto-hiding new leads', async () => {
    const { db, dedupe, project, source, ai } = setup();
    const pipeline = { db, engine: {} as never, ai, emit: () => {}, dedupe };
    for (let u = 1; u <= 3; u++) {
      await qualifyAndAddLeads(pipeline, project, source.id, [
        makeMsg(100, u, BAIT, { senderUserId: 200 + u }),
      ]);
    }
    const tpl = dedupe.listTemplates().find((t) => t.status === 'spam')!;
    dedupe.setTemplateStatus(tpl.id, 'allowed');
    db.listLeads(project.id, { status: 'all' }).forEach((l) => {
      expect(l.status).toBe('new');
    });
    await qualifyAndAddLeads(pipeline, project, source.id, [
      makeMsg(102, 99, homoglyphBait(), { senderUserId: 999 }),
    ]);
    const visible = db.listLeads(project.id);
    expect(visible.some((l) => l.authorUserId === 999)).toBe(true);
  });

  it('runs dedupe before categorizer (spam skips classify)', async () => {
    const { db, dedupe, project, source, ai } = setup();
    const classify = vi.fn(async () => []);
    const categorizer: Categorizer = { classify };
    const pipeline = { db, engine: {} as never, ai, emit: () => {}, dedupe, categorizer };
    for (let u = 1; u <= 3; u++) {
      await qualifyAndAddLeads(pipeline, project, source.id, [
        makeMsg(100, u, BAIT, { senderUserId: 300 + u }),
      ]);
    }
    classify.mockClear();
    await qualifyAndAddLeads(pipeline, project, source.id, [
      makeMsg(100, 50, homoglyphBait(), { senderUserId: 400 }),
    ]);
    expect(classify).not.toHaveBeenCalled();
  });

  it('prunes fingerprints older than 30 days', () => {
    const db = new Db(':memory:');
    const dedupe = createDedupe({ db, emit: () => {} });
    const old = Date.now() - 31 * 86400_000;
    db.raw.prepare(
      `INSERT INTO message_fingerprints(tg_chat_id, tg_message_id, sender_user_id, cluster_id, exact_hash, simhash, sample, created_at)
       VALUES(1, 1, 1, 'x', 'h', '0', 't', ?)`,
    ).run(old);
    dedupe.learn(1, [makeMsg(2, 2, 'fresh message long enough here', { senderUserId: 2 })]);
    pruneFingerprints(db);
    const rows = db.raw.prepare('SELECT COUNT(*) AS n FROM message_fingerprints').get() as { n: number };
    expect(rows.n).toBe(1);
  });
});

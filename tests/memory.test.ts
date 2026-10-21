import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { DEFAULT_MANAGER } from '../src/shared/types';
import type { ChatMessage, Lead, Order } from '../src/shared/types';
import { createMemoryStore } from '../src/main/memory/store';
import { createFakeEmbedder } from '../src/main/memory/embedder';
import { createApp } from '../src/main/app';
import { FakeAi, FakeEngine, FakeManager, FakeSpeech } from './fakes';

function setupDb() {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 50, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 't',
    offer: 'o',
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    geo: [],
    languages: ['ru'],
    accountIds: [acc.id],
    materials: [],
    keywords: [],
  });
  return { db, acc, project };
}

function lead(
  db: Db,
  projectId: number,
  patch: Partial<Lead> & { authorUserId: number; tgMessageId: number },
): Lead {
  return db.addLead({
    projectId,
    sourceId: null,
    tgChatId: patch.tgChatId ?? 100,
    tgMessageId: patch.tgMessageId,
    authorUserId: patch.authorUserId,
    authorName: patch.authorName ?? 'User',
    authorUsername: patch.authorUsername ?? 'user',
    text: patch.text ?? 'Запрос',
    date: patch.date ?? Date.now(),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
}

function msg(leadId: number, patch: Partial<ChatMessage> & { text: string; id?: number }): ChatMessage {
  return {
    id: patch.id ?? 1,
    leadId,
    accountId: null,
    direction: patch.direction ?? 'in',
    where: 'dm',
    kind: patch.kind ?? 'text',
    text: patch.text,
    mediaPath: patch.mediaPath ?? null,
    durationSec: null,
    tgChatId: 1,
    tgMessageId: patch.tgMessageId ?? 1,
    date: patch.date ?? Date.now(),
    auto: false,
  };
}

describe('memory store', () => {
  let dataDir: string;

  afterEach(() => {
    if (dataDir) {
      try {
        const { rmSync } = require('node:fs');
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('merges clients across two leads of the same Telegram user', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const engine = new FakeEngine();
    const store = createMemoryStore({
      db,
      engine,
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
    });
    const l1 = lead(db, project.id, { authorUserId: 42, tgMessageId: 1 });
    const l2 = lead(db, project.id, { authorUserId: 42, tgMessageId: 2, tgChatId: 101 });
    const c1 = store.ensureClient(l1)!;
    const c2 = store.ensureClient(l2)!;
    expect(c1.id).toBe(c2.id);
    expect(db.getLead(l1.id).clientId).toBe(c1.id);
    expect(db.getLead(l2.id).clientId).toBe(c1.id);
    store.stop();
  });

  it('finds facts via FTS', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 1, tgMessageId: 1 });
    const store = createMemoryStore({
      db,
      engine: new FakeEngine(),
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
    });
    const client = store.ensureClient(l)!;
    store.remember(client.id, 'preference', 'Клиент любит синий цвет бренда', 'test');
    const hits = store.search(client.id, 'синий');
    expect(hits.facts.some((f) => f.text.includes('синий'))).toBe(true);
    store.stop();
  });

  it('hybrid ranking prefers items in both FTS and vector lists', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 2, tgMessageId: 1 });
    const embedder = createFakeEmbedder((t) => (t.includes('уникальный') ? 0.95 : 0.1));
    const store = createMemoryStore({
      db,
      engine: new FakeEngine(),
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder,
    });
    const client = store.ensureClient(l)!;
    store.remember(client.id, 'other', 'уникальный маркер для поиска', 't');
    store.remember(client.id, 'other', 'другой факт без связи', 't');
    const hits = store.search(client.id, 'уникальный маркер');
    expect(hits.facts[0]?.text).toContain('уникальный');
    store.stop();
  });

  it('compacts episodes and dedupes facts with mocked aux', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 3, tgMessageId: 1 });
    const fetchFn = vi.fn(async () =>
      ({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  summary: 'Клиент обсудил дедлайн.\nХочет MVP.',
                  facts: [
                    { kind: 'deal', text: 'Дедлайн — две недели' },
                    { kind: 'deal', text: 'Дедлайн — две недели' },
                  ],
                }),
              },
            },
          ],
        }),
      }) as Response,
    ) as typeof fetch;

    const store = createMemoryStore({
      db,
      engine: new FakeEngine(),
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
      fetchFn,
    });
    const client = store.ensureClient(l)!;
    store.remember(client.id, 'deal', 'Дедлайн — две недели', 'seed');
    const base = Date.now();
    for (let i = 0; i < 30; i++) {
      const m = db.addMessage({
        leadId: l.id,
        accountId: null,
        direction: 'in',
        where: 'dm',
        text: `Сообщение ${i}`,
        tgChatId: 1,
        tgMessageId: 100 + i,
        date: base + i * 1000,
        auto: false,
      });
      store.onMessage(m);
    }
    await vi.waitFor(() => store.listEpisodes(client.id).length > 0, { timeout: 3000 });
    const facts = store.listFacts(client.id).filter((f) => f.active && f.text.includes('Дедлайн'));
    expect(facts.length).toBeLessThanOrEqual(2);
    store.stop();
  });

  it('trims context to token budget', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 4, tgMessageId: 1 });
    const store = createMemoryStore({
      db,
      engine: new FakeEngine(),
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
    });
    store.ensureClient(l);
    for (let i = 0; i < 40; i++) {
      db.addMessage({
        leadId: l.id,
        accountId: null,
        direction: 'in',
        where: 'dm',
        text: 'x'.repeat(400),
        tgChatId: 1,
        tgMessageId: i,
        date: Date.now() + i,
        auto: false,
      });
    }
    const ctx = store.context(l.id, 'запрос', 800);
    expect(ctx.tokens).toBeLessThanOrEqual(800);
    store.stop();
  });

  it('captures order output as delivered asset', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 5, tgMessageId: 1 });
    const src = join(dataDir, 'out.jpg');
    writeFileSync(src, 'fake-image');
    const store = createMemoryStore({
      db,
      engine: new FakeEngine(),
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
      fetchFn: vi.fn() as typeof fetch,
    });
    const client = store.ensureClient(l)!;
    const service = db.listServices()[0];
    const order = db.createOrder(l.id, service.id, 'бриф');
    const orderWithFile: Order = {
      ...order,
      files: [{ path: src, role: 'output', name: 'out.jpg', mime: 'image/jpeg' }],
      status: 'delivered',
    };
    store.onOrder(orderWithFile);
    await vi.waitFor(() => store.listAssets(client.id).length > 0, { timeout: 2000 });
    const assets = store.listAssets(client.id);
    expect(assets.some((a) => a.role === 'delivered')).toBe(true);
    store.stop();
  });

  it('sendAsset sends a photo via engine', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-mem-'));
    const { db, acc, project } = setupDb();
    const l = lead(db, project.id, { authorUserId: 600, tgMessageId: 1 });
    db.updateLead(l.id, { accountId: acc.id });
    const engine = new FakeEngine();
    const path = join(dataDir, 'photo.jpg');
    writeFileSync(path, 'img');
    const store = createMemoryStore({
      db,
      engine,
      dataDir,
      settings: () => db.getSettings(),
      emit: () => {},
      embedder: createFakeEmbedder(),
    });
    const client = store.ensureClient(l)!;
    const asset = store.addAsset({
      clientId: client.id,
      orderId: null,
      path,
      mime: 'image/jpeg',
      name: 'photo.jpg',
      role: 'from_client',
      caption: 'тест',
    });
    const sendPhoto = vi.spyOn(engine, 'sendPhoto');
    await store.sendAsset(l.id, asset.id);
    expect(sendPhoto).toHaveBeenCalledTimes(1);
    store.stop();
  });
});

describe('memory live embedder', () => {
  it.skipIf(!process.env.EMBED_LIVE)(
    'embeds two texts and one image with the real model',
    async () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'tg-live-embed-'));
      const { dot } = await import('../src/main/memory/embedder');
      const core = await import('../src/main/memory/embedder-core');
      core.setEmbedderCacheDir(join(dataDir, 'models'));
      const t0 = performance.now();
      const a = await core.embedQueryText('поиск клиентов в Telegram');
      const t1 = performance.now();
      const b = await core.embedDocumentText('ниша EdTech', 'профиль клиента');
      const t2 = performance.now();
      const imgPath = join(dataDir, 'dot.png');
      writeFileSync(
        imgPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      const c = await core.embedImagePath(imgPath);
      const t3 = performance.now();
      core.unloadEmbedderModel();
      expect(a.length).toBe(768);
      expect(b.length).toBe(768);
      expect(c.length).toBe(768);
      expect(dot(a, b)).toBeLessThan(0.99);
      console.log(
        `embed timings ms: query=${(t1 - t0).toFixed(0)} doc=${(t2 - t1).toFixed(0)} image=${(t3 - t2).toFixed(0)}`,
      );
      const { statSync, readdirSync, existsSync } = await import('node:fs');
      const modelsDir = join(dataDir, 'models');
      let cacheBytes = 0;
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else cacheBytes += st.size;
        }
      };
      if (existsSync(modelsDir)) walk(modelsDir);
      console.log(`model cache ~${(cacheBytes / 1e6).toFixed(1)} MB under ${modelsDir}`);
    },
    120_000,
  );
});

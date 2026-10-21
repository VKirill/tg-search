import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { createOrders } from '../src/main/pipeline/orders';
import { createManagerAgent } from '../src/main/pipeline/managerAgent';
import { createApp } from '../src/main/app';
import type { Executor, ExecutorRegistry } from '../src/main/executors/types';
import type { PaymentProvider, PaymentStatus } from '../src/main/payments/types';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine, FakeManager, FakeSpeech, makeMsg } from './fakes';

class FakePayments implements PaymentProvider {
  createCalls: { orderId: number; amount: number }[] = [];
  statuses = new Map<string, PaymentStatus>();

  async create(key: string, amountRub: number, _description: string, _returnUrl: string): Promise<{ id: string; url: string }> {
    const orderId = Number(key.split('-')[1]);
    this.createCalls.push({ orderId, amount: amountRub });
    const id = `pay-${orderId}`;
    this.statuses.set(id, 'pending');
    return { id, url: 'https://pay.test/checkout' };
  }

  async status(paymentId: string): Promise<PaymentStatus> {
    return this.statuses.get(paymentId) ?? 'pending';
  }
}

function makeExecutors(runFn: Executor['run'], previewFn?: Executor['preview']): ExecutorRegistry {
  const base: Executor = {
    estimate: async () => ({ price: 800, reason: 'средняя сложность' }),
    preview:
      previewFn ??
      (async () => ({
        text: 'Превью готово',
        files: [{ path: '/tmp/preview.jpg', role: 'preview', name: 'preview.jpg', mime: 'image/jpeg' }],
      })),
    run: runFn,
  };
  return {
    homework: base,
    marketplace_card: base,
    image_gen: base,
    copywriting: base,
    assistant: base,
    agent: base,
  };
}

function setupDb() {
  const db = new Db(':memory:');
  const acc = db.upsertAccountByPhone('+79990001122');
  db.updateAccount(acc.id, { status: 'authorized', dailyLimit: 20, pauseSec: 0 });
  const project = db.createProject({
    name: 'P',
    task: 'clients',
    target: 't',
    offer: 'o',
    criteria: '',
    sequence: [],
    manager: { ...DEFAULT_MANAGER, enabled: true, replyDelaySec: 1 },
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
    authorName: 'Client',
    authorUsername: 'client',
    text: 'Нужна помощь',
    date: Date.now(),
    link: null,
    score: 90,
    label: 'demand',
    reason: '',
  })!;
  db.updateLead(lead.id, { accountId: acc.id });
  const services = db.listServices();
  const service = services[0];
  return { db, acc, project, lead, service };
}

function ordersPipeline(
  db: Db,
  engine: FakeEngine,
  payments: FakePayments,
  executors: ExecutorRegistry,
  dataDir: string,
) {
  const events: import('../src/shared/types').AppEvent[] = [];
  const emit = (e: import('../src/shared/types').AppEvent) => events.push(e);
  const orders = createOrders({
    db,
    engine,
    ai: new FakeAi(),
    emit,
    dataDir,
    payments: payments as PaymentProvider,
    executors,
  });
  return { orders, events, emit };
}

describe('orders pipeline', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tg-orders-'));
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('rejects payment when price is outside service range', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(db, engine, payments, makeExecutors(async () => ({ text: '', files: [] })), dataDir);
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin - 1 });
    await expect(orders.requestPayment(order.id)).rejects.toThrow('Цена должна быть');
  });

  it('requestPayment sends link through limiter', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({ text: 'ok', files: [] })),
      dataDir,
    );
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin });
    await orders.requestPayment(order.id);
    expect(payments.createCalls).toHaveLength(1);
    expect(engine.sent).toHaveLength(1);
    expect(engine.sent[0].text).toContain('https://pay.test/checkout');
    expect(db.getOrder(order.id).status).toBe('awaiting_payment');
  });

  it('poller marks paid and runs executor', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const outPath = join(dataDir, 'out.jpg');
    writeFileSync(outPath, 'x');
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({
        text: 'Готово',
        files: [{ path: outPath, role: 'output', name: 'out.jpg', mime: 'image/jpeg' }],
      })),
      dataDir,
    );
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin, paymentId: 'pay-1', status: 'awaiting_payment' });
    payments.statuses.set('pay-1', 'succeeded');
    orders.startPoller();
    await vi.advanceTimersByTimeAsync(30_000);
    const o = db.getOrder(order.id);
    expect(o.status).toBe('delivered');
    expect(o.paidAt).not.toBeNull();
    orders.stopPoller();
  });

  it('executor failure sets failed and handoff', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders, emit } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => {
        throw new Error('не могу');
      }),
      dataDir,
    );
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin, status: 'paid' });
    await orders.run(order.id);
    expect(db.getOrder(order.id).status).toBe('failed');
    expect(db.getLead(lead.id).handoff).toBe(true);
    expect(db.getLead(lead.id).handoffReason).toContain('Исполнитель не справился');
    expect(emit).toBeDefined();
  });

  it('deliver sends photos and documents to private chat', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const img = join(dataDir, 'out.jpg');
    const doc = join(dataDir, 'out.pdf');
    writeFileSync(img, 'i');
    writeFileSync(doc, 'd');
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({
        text: 'Результат',
        files: [
          { path: img, role: 'output', name: 'out.jpg', mime: 'image/jpeg' },
          { path: doc, role: 'output', name: 'out.pdf', mime: 'application/pdf' },
        ],
      })),
      dataDir,
    );
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin, status: 'paid' });
    await orders.run(order.id);
    expect(engine.sentFiles.some((f) => f.kind === 'photo' && f.chatId === lead.authorUserId)).toBe(true);
    expect(engine.sentFiles.some((f) => f.kind === 'document')).toBe(true);
  });

  it('revision limit enforced', async () => {
    const { db, lead, service } = setupDb();
    db.updateService(service.id, { revisions: 0, agent: '' });
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({ text: 'x', files: [] })),
      dataDir,
    );
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { status: 'delivered', revisionsUsed: 0 });
    await expect(orders.handlePostManagerReply(lead.id, { reply: 'правка', handoff: false, reason: '' }, 'правка')).rejects.toThrow(
      'Лимит бесплатных правок',
    );
  });

  it('applies manager intent: create order, preview, payment', async () => {
    const { db, lead, service } = setupDb();
    db.updateService(service.id, { previewEnabled: true });
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const previewPath = join(dataDir, 'preview.jpg');
    writeFileSync(previewPath, 'p');
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(
        async () => ({ text: 'done', files: [] }),
        async () => ({
          text: 'Смотрите превью',
          files: [{ path: previewPath, role: 'preview', name: 'preview.jpg', mime: 'image/jpeg' }],
        }),
      ),
      dataDir,
    );
    await orders.applyManagerIntent(lead.id, {
      serviceId: service.id,
      brief: 'Домашка по математике',
      agreedPrice: service.priceMin,
      wantsPreview: true,
      readyToPay: true,
      photoConsent: false,
    });
    const o = db.listOrders(lead.id)[0];
    expect(o.brief).toContain('математике');
    expect(o.status).toBe('awaiting_payment');
    expect(engine.sent.some((s) => s.text.includes('https://pay.test'))).toBe(true);
    expect(engine.sentFiles.length).toBeGreaterThan(0);
  });

  it('a repeated intent never re-bills or downgrades a paid order', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(db, engine, payments, makeExecutors(async () => new Promise(() => {})), dataDir);
    const intent = {
      serviceId: service.id, brief: 'Домашка', agreedPrice: service.priceMin, wantsPreview: false, readyToPay: true, photoConsent: false,
    };
    await orders.applyManagerIntent(lead.id, intent);
    const order = db.listOrders(lead.id)[0];
    db.updateOrder(order.id, { status: 'paid', paidAt: Date.now() });
    await orders.applyManagerIntent(lead.id, intent); // the manager repeats itself in the next turn
    expect(db.getOrder(order.id).status).toBe('paid');
    expect(payments.createCalls).toHaveLength(1);
    expect(engine.sent.filter((m) => m.text.includes('https://pay.test'))).toHaveLength(1);
  });

  it('does not resend the payment link while awaiting payment', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(db, engine, payments, makeExecutors(async () => ({ text: '', files: [] })), dataDir);
    const intent = {
      serviceId: service.id, brief: 'Домашка', agreedPrice: service.priceMin, wantsPreview: false, readyToPay: true, photoConsent: false,
    };
    await orders.applyManagerIntent(lead.id, intent);
    await orders.applyManagerIntent(lead.id, intent);
    expect(payments.createCalls).toHaveLength(1);
    expect(db.listOrders(lead.id)[0].status).toBe('awaiting_payment');
  });

  it('rejects agreed price outside range in manager intent', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({ text: '', files: [] })),
      dataDir,
    );
    await expect(
      orders.applyManagerIntent(lead.id, {
        serviceId: service.id,
        brief: 'x',
        agreedPrice: service.priceMax + 100,
        wantsPreview: false,
        readyToPay: false,
        photoConsent: false,
      }),
    ).rejects.toThrow('вне вилки');
  });

  it('saves incoming photo as order input file', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const src = join(dataDir, 'src.jpg');
    writeFileSync(src, 'photo');
    engine.files.set(42, src);
    const { orders } = ordersPipeline(
      db,
      engine,
      payments,
      makeExecutors(async () => ({ text: '', files: [] })),
      dataDir,
    );
    db.createOrder(lead.id, service.id, 'collect inputs');
    await orders.ingestPrivateMedia(
      lead.id,
      1,
      makeMsg(500, 9, '', { photo: { fileId: 42 }, senderUserId: lead.authorUserId! }),
    );
    const o = db.listOrders(lead.id)[0];
    expect(o.files.some((f) => f.role === 'input' && f.mime === 'image/jpeg')).toBe(true);
  });
});

describe('manager + orders', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('wires manager intent through agent', async () => {
    const { db, lead, service, acc } = setupDb();
    const engine = new FakeEngine();
    const manager = new FakeManager();
    const payments = new FakePayments();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-mgr-ord-'));
    const emit = () => {};
    const orders = createOrders({
      db,
      engine,
      ai: new FakeAi(),
      emit,
      dataDir,
      payments: payments as PaymentProvider,
      executors: makeExecutors(async () => ({ text: 'ok', files: [] })),
    });
    const agent = createManagerAgent({ db, engine, ai: new FakeAi(), manager, emit, orders });
    manager.replyResult = {
      reply: 'Цена 500',
      handoff: false,
      reason: '',
      order: {
        serviceId: service.id,
        brief: 'Текст',
        agreedPrice: service.priceMin,
        wantsPreview: false,
        readyToPay: true,
        photoConsent: false,
      },
    };
    agent.onIncoming(lead.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(db.listOrders(lead.id).length).toBe(1);
    expect(db.getOrder(db.listOrders(lead.id)[0].id).status).toBe('awaiting_payment');
    agent.stop();
  });
});

describe('app orders API', () => {
  it('exposes requestPayment', async () => {
    const { db, lead, service } = setupDb();
    const engine = new FakeEngine();
    const payments = new FakePayments();
    const app = createApp({
      db,
      engine,
      ai: new FakeAi(),
      manager: new FakeManager(),
      speech: new FakeSpeech(),
      dataDir: mkdtempSync(join(tmpdir(), 'tg-app-ord-')),
      emit: () => {},
      openExternal: async () => {},
      payments: payments as PaymentProvider,
      executors: makeExecutors(async () => ({ text: 'r', files: [] })),
    });
    const order = await app.orders.create(lead.id, service.id, 'b');
    await app.orders.update(order.id, { price: service.priceMin });
    const paid = await app.orders.requestPayment(order.id);
    expect(paid.paymentUrl).toContain('https://pay.test');
  });
});

describe('photos attached to a new order', () => {
  it('only what came after the previous order — not last task\'s pictures', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-orders-media-'));
    const { db, lead, service } = setupDb();
    const { orders } = ordersPipeline(db, new FakeEngine(), new FakePayments(), makeExecutors(async () => ({ text: '', files: [] })), dataDir);
    const photo = (name: string, date: number) => {
      const path = join(dataDir, name);
      writeFileSync(path, 'x');
      db.addMessage({ leadId: lead.id, accountId: null, direction: 'in', where: 'dm', kind: 'text', text: '[фото]', mediaPath: path,
        tgChatId: 1, tgMessageId: date, date, auto: false });
    };
    const now = Date.now();
    photo('bed.jpg', now - 60_000);
    const first = db.createOrder(lead.id, service.id, 'карточка');
    db.raw.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(now - 30_000, first.id);
    db.updateOrder(first.id, { status: 'done' });
    photo('homework.jpg', now - 10_000);
    await orders.applyManagerIntent(lead.id, {
      serviceId: db.listServices()[1].id, brief: 'задача 10', agreedPrice: null, wantsPreview: false, readyToPay: false, photoConsent: false,
    });
    const created = db.listOrders(lead.id).find((o) => o.id !== first.id)!;
    expect(created.files.map((f) => f.name)).toEqual(['homework.jpg']);
  });
});

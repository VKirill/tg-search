import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Db } from '../src/main/db';
import { createBilling } from '../src/main/billing/billing';
import { createOrders } from '../src/main/pipeline/orders';
import type { PaymentProvider, PaymentStatus } from '../src/main/payments/types';
import type { Executor, ExecutorRegistry } from '../src/main/executors/types';
import { DEFAULT_MANAGER } from '../src/shared/types';
import { FakeAi, FakeEngine } from './fakes';

const SCHEDULER_MS = 30 * 60 * 1000;

class FakePayments implements PaymentProvider {
  statuses = new Map<string, PaymentStatus>();
  createCalls: { ledgerId: number; amount: number }[] = [];

  async create(key: string, amountRub: number, _description: string, _returnUrl: string) {
    const ledgerId = Number(key.split('-').pop());
    this.createCalls.push({ ledgerId, amount: amountRub });
    const id = `pay-${ledgerId}`;
    this.statuses.set(id, 'pending');
    return { id, url: `https://pay.test/${ledgerId}` };
  }

  async status(paymentId: string): Promise<PaymentStatus> {
    return this.statuses.get(paymentId) ?? 'pending';
  }
}

function makeExecutors(runFn: Executor['run']): ExecutorRegistry {
  const base: Executor = {
    estimate: async () => ({ price: 800, reason: 'x' }),
    preview: async () => ({ text: '', files: [] }),
    run: runFn,
  };
  return {
    homework: base,
    marketplace_card: base,
    image_gen: base,
    copywriting: base,
    assistant: base,
  };
}

function setup() {
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
    manager: { ...DEFAULT_MANAGER, enabled: true },
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
  const clientId = 42;
  db.raw.prepare('UPDATE leads SET client_id = ? WHERE id = ?').run(clientId, lead.id);
  return { db, lead, clientId, acc, project };
}

describe('billing', () => {
  let t0: number;
  let sent: string[];
  let payments: FakePayments;

  beforeEach(() => {
    vi.useFakeTimers();
    t0 = Date.parse('2026-06-01T12:00:00Z');
    vi.setSystemTime(t0);
    sent = [];
    payments = new FakePayments();
  });

  afterEach(() => vi.useRealTimers());

  function billingFor(db: Db) {
    const events: import('../src/shared/types').AppEvent[] = [];
    return createBilling({
      db,
      payments,
      emit: (e) => events.push(e),
      sendToClient: async (_leadId, text) => {
        sent.push(text);
      },
      leadForClient: (clientId) => {
        const row = db.raw.prepare('SELECT id FROM leads WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId) as
          | { id: number }
          | undefined;
        return row?.id ?? null;
      },
      onOrderPaid: async () => {},
      now: () => t0,
    });
  }

  it('seeds default plan and subscribe sends payment link', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plans = billing.listPlans();
    expect(plans.some((p) => p.name === 'Личный ассистент' && p.priceMonth === 1990)).toBe(true);
    const plan = plans[0];
    await billing.subscribe(clientId, plan.id);
    expect(sent.some((s) => s.includes('https://pay.test/'))).toBe(true);
    const st = billing.status(clientId);
    expect(st.subscription?.status).toBe('pending');
    expect(st.unpaid).toHaveLength(1);
  });

  it('a repeated subscribe does not create a second invoice', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    const first = await billing.subscribe(clientId, plan.id);
    const again = await billing.subscribe(clientId, plan.id); // the agent offers it once more
    expect(again.id).toBe(first.id);
    expect(payments.createCalls).toHaveLength(1);
    expect(sent.filter((s) => s.includes('https://pay.test/'))).toHaveLength(1);
  });

  it('paid subscription becomes active with one-month period', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    await billing.subscribe(clientId, plan.id);
    const unpaid = billing.status(clientId).unpaid[0];
    payments.statuses.set(unpaid.providerId!, 'succeeded');
    const paid = await billing.check(unpaid.id);
    expect(paid.status).toBe('succeeded');
    const sub = billing.status(clientId).subscription!;
    expect(sub.status).toBe('active');
    expect(sub.periodStart).toBe(t0);
    const expectedEnd = new Date(t0);
    expectedEnd.setMonth(expectedEnd.getMonth() + 1);
    expect(sub.periodEnd).toBe(expectedEnd.getTime());
    expect(sub.tasksUsed).toBe(0);
  });

  it('sends renewal reminder once three days before period end', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    const periodEnd = t0 + 2 * 24 * 60 * 60 * 1000;
    db.raw
      .prepare(
        `INSERT INTO subscriptions(client_id, plan_id, status, period_start, period_end, tasks_used, created_at)
         VALUES(?, ?, 'active', ?, ?, 0, ?)`,
      )
      .run(clientId, plan.id, t0 - 28 * 24 * 60 * 60 * 1000, periodEnd, t0);
    billing.start();
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS);
    expect(sent.filter((s) => s.includes('Продление')).length).toBe(1);
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS);
    expect(sent.filter((s) => s.includes('Продление')).length).toBe(1);
    billing.stop();
  });

  it('marks subscription past_due after period end without payment', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    const periodEnd = t0 - 1000;
    db.raw
      .prepare(
        `INSERT INTO subscriptions(client_id, plan_id, status, period_start, period_end, tasks_used, created_at)
         VALUES(?, ?, 'active', ?, ?, 5, ?)`,
      )
      .run(clientId, plan.id, t0 - 30 * 24 * 60 * 60 * 1000, periodEnd, t0);
    billing.start();
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS);
    expect(billing.status(clientId).subscription?.status).toBe('past_due');
    billing.stop();
  });

  it('renewal extends from previous period end and resets quota', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    const periodEnd = t0 + 5 * 24 * 60 * 60 * 1000;
    const subRun = db.raw
      .prepare(
        `INSERT INTO subscriptions(client_id, plan_id, status, period_start, period_end, tasks_used, created_at)
         VALUES(?, ?, 'active', ?, ?, 12, ?)`,
      )
      .run(clientId, plan.id, t0 - 25 * 24 * 60 * 60 * 1000, periodEnd, t0);
    const subId = Number(subRun.lastInsertRowid);
    const ledger = billing.recordPayment({
      clientId,
      purpose: 'subscription',
      orderId: null,
      subscriptionId: subId,
      amount: plan.priceMonth,
      status: 'pending',
      providerId: 'pay-renew',
      url: 'https://pay.test/renew',
      paidAt: null,
    });
    payments.statuses.set('pay-renew', 'succeeded');
    await billing.check(ledger.id);
    const sub = billing.status(clientId).subscription!;
    const expectedEnd = new Date(periodEnd);
    expectedEnd.setMonth(expectedEnd.getMonth() + 1);
    expect(sub.periodEnd).toBe(expectedEnd.getTime());
    expect(sub.tasksUsed).toBe(0);
  });

  it('consumeTask respects active subscription quota', async () => {
    const { db, clientId } = setup();
    const billing = billingFor(db);
    const plan = billing.listPlans()[0];
    db.raw
      .prepare(
        `INSERT INTO subscriptions(client_id, plan_id, status, period_start, period_end, tasks_used, created_at)
         VALUES(?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(clientId, plan.id, t0, t0 + 30 * 24 * 60 * 60 * 1000, plan.tasksPerMonth - 1, t0);
    expect(billing.consumeTask(clientId)).toBe(true);
    expect(billing.consumeTask(clientId)).toBe(false);
  });

  it('order payment recorded and fulfilled via billing check without double run', async () => {
    const { db, lead, clientId } = setup();
    const dataDir = mkdtempSync(join(tmpdir(), 'tg-billing-'));
    const engine = new FakeEngine();
    let runCount = 0;
    const outPath = join(dataDir, 'out.jpg');
    writeFileSync(outPath, 'x');
    const billingRef: { current?: ReturnType<typeof createBilling> } = {};
    const orders = createOrders({
      db,
      engine,
      ai: new FakeAi(),
      emit: () => {},
      dataDir,
      payments,
      executors: makeExecutors(async () => {
        runCount += 1;
        return { text: 'Готово', files: [{ path: outPath, role: 'output', name: 'out.jpg', mime: 'image/jpeg' }] };
      }),
      skipOrderPaymentPoll: true,
      billingRef,
    });
    billingRef.current = createBilling({
      db,
      payments,
      emit: () => {},
      sendToClient: async () => {},
      leadForClient: () => lead.id,
      onOrderPaid: async (orderId) => {
        await orders.markPaid(orderId);
      },
      now: () => t0,
    });
    const service = db.listServices()[0];
    const order = db.createOrder(lead.id, service.id, 'brief');
    db.updateOrder(order.id, { price: service.priceMin });
    await orders.requestPayment(order.id);
    const ledger = billingRef.current.listPayments(clientId).find((p) => p.purpose === 'order');
    expect(ledger?.providerId).toBeTruthy();
    payments.statuses.set(ledger!.providerId!, 'succeeded');
    billingRef.current.start();
    orders.startPoller();
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS);
    expect(runCount).toBe(1);
    await vi.advanceTimersByTimeAsync(SCHEDULER_MS);
    expect(runCount).toBe(1);
    billingRef.current.stop();
    orders.stopPoller();
  });
});

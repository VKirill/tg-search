import type { DatabaseSync } from 'node:sqlite';
import type { AppEvent, Payment, Plan, Subscription } from '../../shared/types';
import type { Db } from '../db';
import type { PaymentProvider, PaymentStatus } from '../payments/types';
import type { Billing, BillingStatus } from './types';
import { ensureBillingSchema } from './schema';

const SCHEDULER_MS = 30 * 60 * 1000;
const POLL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REMINDER_LEAD_MS = 3 * 24 * 60 * 60 * 1000;

type Row = Record<string, unknown>;

export interface BillingDeps {
  db: Db;
  payments: PaymentProvider;
  emit: (e: AppEvent) => void;
  sendToClient: (leadId: number, text: string) => Promise<void>;
  leadForClient: (clientId: number) => number | null;
  onOrderPaid: (orderId: number) => Promise<void>;
  now?: () => number;
}

export interface BillingApi extends Billing {
  listPlans(): Plan[];
  savePlan(plan: Omit<Plan, 'id'> & { id?: number }): Plan;
  removePlan(planId: number): void;
  listSubscriptions(clientId?: number): Subscription[];
  cancelSubscription(subscriptionId: number): Subscription;
  listPayments(clientId?: number): Payment[];
}

function addCalendarMonth(ts: number): number {
  const d = new Date(ts);
  d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

function daysBetween(now: number, end: number | null): number | null {
  if (end == null) return null;
  return Math.max(0, Math.ceil((end - now) / (24 * 60 * 60 * 1000)));
}

function mapPlan(r: Row): Plan {
  return {
    id: r.id as number,
    name: r.name as string,
    priceMonth: r.price_month as number,
    description: r.description as string,
    tasksPerMonth: r.tasks_per_month as number,
    enabled: Boolean(r.enabled),
  };
}

function mapSubscription(r: Row): Subscription {
  return {
    id: r.id as number,
    clientId: r.client_id as number,
    planId: r.plan_id as number,
    status: r.status as Subscription['status'],
    periodStart: (r.period_start as number | null) ?? null,
    periodEnd: (r.period_end as number | null) ?? null,
    tasksUsed: r.tasks_used as number,
    createdAt: r.created_at as number,
  };
}

function mapPayment(r: Row): Payment {
  return {
    id: r.id as number,
    clientId: r.client_id as number,
    purpose: r.purpose as Payment['purpose'],
    orderId: (r.order_id as number | null) ?? null,
    subscriptionId: (r.subscription_id as number | null) ?? null,
    amount: r.amount as number,
    status: r.status as Payment['status'],
    providerId: (r.provider_id as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    createdAt: r.created_at as number,
    paidAt: (r.paid_at as number | null) ?? null,
  };
}

function providerSucceeded(status: PaymentStatus): boolean {
  return status === 'succeeded' || status === 'waiting_for_capture';
}

function seedDefaultPlan(raw: DatabaseSync): void {
  const row = raw.prepare('SELECT 1 FROM plans LIMIT 1').get();
  if (row) return;
  // Price is an estimate for seeding; the owner edits it in the UI.
  raw.prepare(
    `INSERT INTO plans(name, price_month, description, tasks_per_month, enabled) VALUES(?, ?, ?, ?, 1)`,
  ).run(
    'Личный ассистент',
    1990,
    'Поиск и исследования, тексты, карточки, обработка фото — в пределах месячной квоты поручений. Срочное и объёмное — отдельным заказом.',
    30,
  );
}

export function createBilling(deps: BillingDeps): BillingApi {
  const raw = deps.db.raw;
  ensureBillingSchema(raw);
  seedDefaultPlan(raw);
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function notify(clientId: number) {
    deps.emit({ type: 'billing:update', clientId });
  }

  function getPlan(planId: number): Plan {
    const r = raw.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as Row | undefined;
    if (!r) throw new Error('Тариф не найден');
    return mapPlan(r);
  }

  function currentSubscription(clientId: number): Subscription | null {
    const r = raw
      .prepare(
        `SELECT * FROM subscriptions WHERE client_id = ? AND status != 'canceled' ORDER BY id DESC LIMIT 1`,
      )
      .get(clientId) as Row | undefined;
    return r ? mapSubscription(r) : null;
  }

  function listPlans(): Plan[] {
    return (raw.prepare('SELECT * FROM plans ORDER BY id').all() as Row[]).map(mapPlan);
  }

  function savePlan(plan: Omit<Plan, 'id'> & { id?: number }): Plan {
    if (plan.id != null) {
      raw
        .prepare(
          `UPDATE plans SET name = ?, price_month = ?, description = ?, tasks_per_month = ?, enabled = ? WHERE id = ?`,
        )
        .run(plan.name, plan.priceMonth, plan.description, plan.tasksPerMonth, Number(plan.enabled), plan.id);
      return getPlan(plan.id);
    }
    const r = raw
      .prepare(
        `INSERT INTO plans(name, price_month, description, tasks_per_month, enabled) VALUES(?, ?, ?, ?, ?)`,
      )
      .run(plan.name, plan.priceMonth, plan.description, plan.tasksPerMonth, Number(plan.enabled));
    return getPlan(Number(r.lastInsertRowid));
  }

  function removePlan(planId: number): void {
    raw.prepare('DELETE FROM plans WHERE id = ?').run(planId);
  }

  function listSubscriptions(clientId?: number): Subscription[] {
    const rows = clientId != null
      ? (raw.prepare('SELECT * FROM subscriptions WHERE client_id = ? ORDER BY id DESC').all(clientId) as Row[])
      : (raw.prepare('SELECT * FROM subscriptions ORDER BY id DESC').all() as Row[]);
    return rows.map(mapSubscription);
  }

  function listPayments(clientId?: number): Payment[] {
    const rows = clientId != null
      ? (raw.prepare('SELECT * FROM payments WHERE client_id = ? ORDER BY id DESC').all(clientId) as Row[])
      : (raw.prepare('SELECT * FROM payments ORDER BY id DESC').all() as Row[]);
    return rows.map(mapPayment);
  }

  function getPayment(paymentId: number): Payment {
    const r = raw.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId) as Row | undefined;
    if (!r) throw new Error('Платёж не найден');
    return mapPayment(r);
  }

  function recordPayment(p: Omit<Payment, 'id' | 'createdAt'>): Payment {
    const ts = now();
    const r = raw
      .prepare(
        `INSERT INTO payments(client_id, purpose, order_id, subscription_id, amount, status, provider_id, url, created_at, paid_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.clientId,
        p.purpose,
        p.orderId,
        p.subscriptionId,
        p.amount,
        p.status,
        p.providerId,
        p.url,
        ts,
        p.paidAt,
      );
    const payment = getPayment(Number(r.lastInsertRowid));
    notify(p.clientId);
    return payment;
  }

  function patchPayment(paymentId: number, patch: Partial<Pick<Payment, 'status' | 'providerId' | 'url' | 'paidAt'>>): Payment {
    const cur = getPayment(paymentId);
    const status = patch.status ?? cur.status;
    const providerId = patch.providerId !== undefined ? patch.providerId : cur.providerId;
    const url = patch.url !== undefined ? patch.url : cur.url;
    const paidAt = patch.paidAt !== undefined ? patch.paidAt : cur.paidAt;
    raw
      .prepare(`UPDATE payments SET status = ?, provider_id = ?, url = ?, paid_at = ? WHERE id = ?`)
      .run(status, providerId, url, paidAt, paymentId);
    const payment = getPayment(paymentId);
    notify(payment.clientId);
    return payment;
  }

  function activateSubscription(sub: Subscription, paidAt: number): void {
    const renew = sub.periodEnd != null;
    const periodStart = renew ? (sub.periodStart ?? paidAt) : paidAt;
    const periodEnd = addCalendarMonth(renew ? sub.periodEnd! : paidAt);
    raw
      .prepare(
        `UPDATE subscriptions SET status = 'active', period_start = ?, period_end = ?, tasks_used = 0, renewal_reminder_period_end = NULL WHERE id = ?`,
      )
      .run(periodStart, periodEnd, sub.id);
    notify(sub.clientId);
  }

  async function applySucceeded(payment: Payment): Promise<Payment> {
    if (payment.status === 'succeeded') return payment;
    const ts = now();
    const updated = patchPayment(payment.id, { status: 'succeeded', paidAt: ts });
    if (payment.purpose === 'order' && payment.orderId != null) {
      await deps.onOrderPaid(payment.orderId);
    } else if (payment.purpose === 'subscription' && payment.subscriptionId != null) {
      const r = raw.prepare('SELECT * FROM subscriptions WHERE id = ?').get(payment.subscriptionId) as Row;
      const sub = mapSubscription(r);
      activateSubscription(sub, ts);
    }
    return updated;
  }

  async function applyProviderStatus(payment: Payment, status: PaymentStatus): Promise<Payment> {
    if (providerSucceeded(status)) return applySucceeded(payment);
    if (status === 'canceled') return patchPayment(payment.id, { status: 'canceled' });
    return payment;
  }

  async function check(paymentId: number): Promise<Payment> {
    const payment = getPayment(paymentId);
    if (payment.status !== 'pending' || !payment.providerId) return payment;
    const status = await deps.payments.status(payment.providerId);
    return applyProviderStatus(payment, status);
  }

  async function createProviderPayment(
    ledgerId: number,
    amountRub: number,
    description: string,
    returnUrl: string,
  ): Promise<{ id: string; url: string }> {
    return deps.payments.create(`payment-${ledgerId}`, amountRub, description, returnUrl);
  }

  async function sendPaymentLink(clientId: number, text: string): Promise<void> {
    const leadId = deps.leadForClient(clientId);
    if (leadId == null) throw new Error('Нет лида для отправки счёта клиенту');
    await deps.sendToClient(leadId, text);
  }

  async function subscribe(clientId: number, planId: number): Promise<Subscription> {
    const plan = getPlan(planId);
    if (!plan.enabled) throw new Error('Тариф недоступен');
    // One live subscription per client: a repeated offer (the agent may say it twice) must not send a second invoice.
    // Pending: the link was already sent; active/past_due: renewals come from the scheduler.
    const live = currentSubscription(clientId);
    if (live) return live;
    const ts = now();
    const subRun = raw
      .prepare(
        `INSERT INTO subscriptions(client_id, plan_id, status, period_start, period_end, tasks_used, created_at)
         VALUES(?, ?, 'pending', NULL, NULL, 0, ?)`,
      )
      .run(clientId, planId, ts);
    const subId = Number(subRun.lastInsertRowid);
    const settings = deps.db.getSettings();
    const returnUrl = settings.yookassaReturnUrl.trim() || 'https://t.me';
    const description = `${plan.name} — 1 месяц`;
    const ledger = recordPayment({
      clientId,
      purpose: 'subscription',
      orderId: null,
      subscriptionId: subId,
      amount: plan.priceMonth,
      status: 'pending',
      providerId: null,
      url: null,
      paidAt: null,
    });
    const { id, url } = await createProviderPayment(ledger.id, plan.priceMonth, description, returnUrl);
    patchPayment(ledger.id, { providerId: id, url });
    await sendPaymentLink(clientId, `Оплата подписки «${plan.name}» — ${plan.priceMonth} ₽: ${url}`);
    return mapSubscription(raw.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subId) as Row);
  }

  function cancelSubscription(subscriptionId: number): Subscription {
    raw.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE id = ?`).run(subscriptionId);
    const sub = mapSubscription(raw.prepare('SELECT * FROM subscriptions WHERE id = ?').get(subscriptionId) as Row);
    notify(sub.clientId);
    return sub;
  }

  function consumeTask(clientId: number): boolean {
    const sub = currentSubscription(clientId);
    if (!sub || sub.status !== 'active' || sub.periodEnd == null || sub.periodEnd < now()) return false;
    const plan = getPlan(sub.planId);
    if (sub.tasksUsed >= plan.tasksPerMonth) return false;
    raw.prepare('UPDATE subscriptions SET tasks_used = tasks_used + 1 WHERE id = ?').run(sub.id);
    notify(clientId);
    return true;
  }

  function status(clientId: number): BillingStatus {
    const sub = currentSubscription(clientId);
    const plan = sub ? getPlan(sub.planId) : null;
    const unpaid = listPayments(clientId).filter((p) => p.status === 'pending');
    const tasksLeft =
      sub && plan && sub.status === 'active' ? Math.max(0, plan.tasksPerMonth - sub.tasksUsed) : null;
    return {
      subscription: sub,
      plan,
      daysLeft: sub?.periodEnd != null ? daysBetween(now(), sub.periodEnd) : null,
      tasksLeft,
      unpaid,
    };
  }

  async function pollPendingPayments(): Promise<void> {
    const cutoff = now() - POLL_MAX_AGE_MS;
    const rows = raw
      .prepare(`SELECT * FROM payments WHERE status = 'pending' AND provider_id IS NOT NULL AND created_at >= ?`)
      .all(cutoff) as Row[];
    for (const row of rows) {
      const payment = mapPayment(row);
      try {
        const st = await deps.payments.status(payment.providerId!);
        await applyProviderStatus(payment, st);
      } catch (err) {
        console.error('billing payment poll', payment.id, err);
      }
    }
  }

  async function ensureRenewalInvoice(sub: Subscription, plan: Plan): Promise<void> {
    const periodEnd = sub.periodEnd!;
    const r = raw.prepare('SELECT renewal_reminder_period_end FROM subscriptions WHERE id = ?').get(sub.id) as Row;
    if (r.renewal_reminder_period_end === periodEnd) return;
    const pending = raw
      .prepare(
        `SELECT 1 FROM payments WHERE subscription_id = ? AND purpose = 'subscription' AND status = 'pending' AND created_at >= ? LIMIT 1`,
      )
      .get(sub.id, sub.periodStart ?? 0);
    if (pending) return;

    const settings = deps.db.getSettings();
    const returnUrl = settings.yookassaReturnUrl.trim() || 'https://t.me';
    const description = `${plan.name} — продление на 1 месяц`;
    const ledger = recordPayment({
      clientId: sub.clientId,
      purpose: 'subscription',
      orderId: null,
      subscriptionId: sub.id,
      amount: plan.priceMonth,
      status: 'pending',
      providerId: null,
      url: null,
      paidAt: null,
    });
    const { id, url } = await createProviderPayment(ledger.id, plan.priceMonth, description, returnUrl);
    patchPayment(ledger.id, { providerId: id, url });
    raw.prepare('UPDATE subscriptions SET renewal_reminder_period_end = ? WHERE id = ?').run(periodEnd, sub.id);
    await sendPaymentLink(
      sub.clientId,
      `Напоминаем: подписка «${plan.name}» заканчивается ${new Date(periodEnd).toLocaleDateString('ru-RU')}. Продление — ${plan.priceMonth} ₽: ${url}`,
    );
  }

  async function tickRenewals(): Promise<void> {
    const t = now();
    const rows = raw.prepare(`SELECT * FROM subscriptions WHERE status IN ('active', 'past_due')`).all() as Row[];
    for (const row of rows) {
      const sub = mapSubscription(row);
      if (sub.periodEnd == null) continue;
      const plan = getPlan(sub.planId);
      const msLeft = sub.periodEnd - t;
      if (sub.status === 'active' && msLeft > 0 && msLeft <= REMINDER_LEAD_MS) {
        await ensureRenewalInvoice(sub, plan);
      }
      if (sub.status === 'active' && sub.periodEnd < t) {
        const openRenewal = raw
          .prepare(
            `SELECT 1 FROM payments WHERE subscription_id = ? AND purpose = 'subscription' AND status = 'pending' LIMIT 1`,
          )
          .get(sub.id);
        if (!openRenewal) {
          raw.prepare(`UPDATE subscriptions SET status = 'past_due' WHERE id = ?`).run(sub.id);
          notify(sub.clientId);
          const leadId = deps.leadForClient(sub.clientId);
          if (leadId != null) {
            await deps.sendToClient(
              leadId,
              `Подписка «${plan.name}» приостановлена — оплата за новый период не поступила. Напишите, если нужна помощь с оплатой.`,
            );
          }
        }
      }
    }
  }

  async function schedulerTick(): Promise<void> {
    await pollPendingPayments();
    await tickRenewals();
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(() => {
      schedulerTick().catch((err) => console.error('billing scheduler', err));
    }, SCHEDULER_MS);
    timer.unref();
    schedulerTick().catch((err) => console.error('billing scheduler', err));
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    status,
    subscribe,
    consumeTask,
    recordPayment,
    check,
    start,
    stop,
    listPlans,
    plans: () => listPlans(),
    savePlan,
    removePlan,
    listSubscriptions,
    cancelSubscription,
    listPayments,
  };
}

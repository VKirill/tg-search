// Contract of billing: subscriptions, plans, the payments ledger. Implemented in ./billing.ts.

import type { Payment, Plan, Subscription } from '../../shared/types';

export interface BillingStatus {
  subscription: Subscription | null; // the client's current (non-canceled) subscription
  plan: Plan | null;
  daysLeft: number | null;
  tasksLeft: number | null;
  unpaid: Payment[]; // pending payments the client still has to pay
}

export interface Billing {
  plans(): Plan[]; // enabled and disabled; the operator sells the enabled ones
  status(clientId: number): BillingStatus;
  subscribe(clientId: number, planId: number): Promise<Subscription>; // creates it and sends the invoice
  consumeTask(clientId: number): boolean; // false without an active subscription or when the quota is spent
  recordPayment(p: Omit<Payment, 'id' | 'createdAt'>): Payment;
  check(paymentId: number): Promise<Payment>; // asks the provider, updates the ledger and dependent order/subscription
  start(): void; // renewal reminders and polling
  stop(): void;
}

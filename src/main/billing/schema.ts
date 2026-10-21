import type { DatabaseSync } from 'node:sqlite';

const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_month INTEGER NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tasks_per_month INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL,
  period_start INTEGER,
  period_end INTEGER,
  tasks_used INTEGER NOT NULL DEFAULT 0,
  renewal_reminder_period_end INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS subscriptions_client ON subscriptions(client_id);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  order_id INTEGER,
  subscription_id INTEGER REFERENCES subscriptions(id),
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  url TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS payments_client ON payments(client_id);
CREATE INDEX IF NOT EXISTS payments_status ON payments(status);
`;

export function ensureBillingSchema(raw: DatabaseSync): void {
  raw.exec(BILLING_SCHEMA);
}

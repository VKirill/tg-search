import type { DatabaseSync } from 'node:sqlite';

export const DEDUPE_DDL = `
CREATE TABLE IF NOT EXISTS message_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_chat_id INTEGER NOT NULL,
  tg_message_id INTEGER NOT NULL,
  sender_user_id INTEGER,
  cluster_id TEXT NOT NULL,
  exact_hash TEXT NOT NULL,
  simhash TEXT NOT NULL,
  sample TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(tg_chat_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS idx_mfp_cluster ON message_fingerprints(cluster_id);
CREATE INDEX IF NOT EXISTS idx_mfp_created ON message_fingerprints(created_at);
CREATE INDEX IF NOT EXISTS idx_mfp_exact ON message_fingerprints(exact_hash);

CREATE TABLE IF NOT EXISTS fingerprint_cluster_authors (
  cluster_id TEXT NOT NULL,
  sender_user_id INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY(cluster_id, sender_user_id)
);

CREATE TABLE IF NOT EXISTS spam_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sample TEXT NOT NULL,
  exact_hash TEXT NOT NULL,
  simhash TEXT NOT NULL,
  authors INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'spam',
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_spam_tpl_hash ON spam_templates(exact_hash);

CREATE TABLE IF NOT EXISTS spam_chats (
  tg_chat_id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  username TEXT,
  reason TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  live_share REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mfp_chat ON message_fingerprints(tg_chat_id, created_at);
`;

const ensured = new WeakSet<DatabaseSync>();

export function ensureDedupeSchema(raw: DatabaseSync): void {
  if (ensured.has(raw)) return;
  ensured.add(raw);
  raw.exec(DEDUPE_DDL);
  const cols = (raw.prepare('PRAGMA table_info(spam_templates)').all() as { name: string }[]).map((c) => c.name);
  // the cluster of a template: a message matching any of its variants is spam, not only one matching the sample
  if (!cols.includes('cluster_id')) raw.exec('ALTER TABLE spam_templates ADD COLUMN cluster_id TEXT');
}

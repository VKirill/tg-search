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
`;

export function ensureDedupeSchema(raw: DatabaseSync): void {
  raw.exec(DEDUPE_DDL);
}

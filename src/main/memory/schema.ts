// Memory tables (separate from src/main/db.ts SCHEMA to avoid merge conflicts).

import type { DatabaseSync } from 'node:sqlite';

export function ensureMemorySchema(raw: DatabaseSync): void {
  raw.exec(`
CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_user_id INTEGER UNIQUE,
  name TEXT NOT NULL,
  username TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_facts_client ON memory_facts(client_id);
CREATE TABLE IF NOT EXISTS memory_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  from_ms INTEGER NOT NULL,
  to_ms INTEGER NOT NULL,
  summary TEXT NOT NULL,
  messages INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_episodes_client ON memory_episodes(client_id);
CREATE TABLE IF NOT EXISTS memory_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  order_id INTEGER,
  path TEXT NOT NULL,
  mime TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_assets_client ON memory_assets(client_id);
CREATE TABLE IF NOT EXISTS memory_vectors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  modality TEXT NOT NULL DEFAULT 'text',
  client_id INTEGER NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  UNIQUE(owner_type, owner_id, modality)
);
CREATE INDEX IF NOT EXISTS memory_vectors_client ON memory_vectors(client_id);
CREATE TABLE IF NOT EXISTS memory_client_meta (
  client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  msgs_since_compact INTEGER NOT NULL DEFAULT 0,
  window_from_ms INTEGER,
  last_incoming_ms INTEGER
);
`);

  const fts = raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_fts'").get();
  if (!fts) {
    raw.exec(`
CREATE VIRTUAL TABLE memory_fts USING fts5(
  body,
  client_id UNINDEXED,
  owner_type UNINDEXED,
  owner_id UNINDEXED,
  tokenize='unicode61'
);
`);
  }

  migrateLeadsToClients(raw);
}

function migrateLeadsToClients(raw: DatabaseSync): void {
  raw.exec(`
INSERT INTO clients (tg_user_id, name, username, created_at, last_seen_at)
SELECT author_user_id, COALESCE(author_name, 'Клиент'), author_username, MIN(created_at), MAX(date)
FROM leads
WHERE author_user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM clients c WHERE c.tg_user_id = leads.author_user_id)
GROUP BY author_user_id;
`);
  raw.exec(`
UPDATE leads
SET client_id = (SELECT c.id FROM clients c WHERE c.tg_user_id = leads.author_user_id)
WHERE client_id IS NULL AND author_user_id IS NOT NULL;
`);
}

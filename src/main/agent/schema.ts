import type { DatabaseSync } from 'node:sqlite';
import type { Db } from '../db';

const AGENT_STEPS_DDL = `
CREATE TABLE IF NOT EXISTS agent_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  ok INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_steps_lead ON agent_steps(lead_id, ts);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, created_at);
`;

const ASSISTANT_SERVICE = {
  kind: 'assistant',
  name: 'Поручение ассистента',
  priceMin: 300,
  priceMax: 3000,
  previewEnabled: true,
  enabled: true,
  instructions:
    'Любые поручения: поиск в интернете, списки поставщиков, исследования, сводки, сравнения. ' +
    'Уточнить город, срок и формат результата. Цена 300–800 ₽ за простой поиск, до 3000 ₽ за глубокое исследование с источниками. ' +
    'Результат — текст в Markdown со списком источников (URL). Превью — краткий план из 3–5 пунктов.',
  model: '',
  revisions: 1,
  categoryId: null as number | null,
};

export function ensureAgentSchema(raw: DatabaseSync, db?: Db): void {
  raw.exec(AGENT_STEPS_DDL);
  if (!db) return;
  const hasAssistant = db.listServices().some((s) => s.kind === 'assistant');
  if (!hasAssistant) {
    db.createService({
      kind: 'assistant',
      name: ASSISTANT_SERVICE.name,
      categoryId: ASSISTANT_SERVICE.categoryId,
      enabled: ASSISTANT_SERVICE.enabled,
      priceMin: ASSISTANT_SERVICE.priceMin,
      priceMax: ASSISTANT_SERVICE.priceMax,
      instructions: ASSISTANT_SERVICE.instructions,
      model: ASSISTANT_SERVICE.model,
      previewEnabled: ASSISTANT_SERVICE.previewEnabled,
      revisions: ASSISTANT_SERVICE.revisions,
      agent: '',
    });
  }
}

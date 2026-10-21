// What every model did: each attempt of a helper job (subagent task, executor request, one-shot) with its outcome, the
// verifier's score, the primary agent's review and the client's corrections. The router reads it back as each model's
// track record per job kind, so models that keep failing a kind of job sink and reliable ones rise.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Db } from '../db';

export type RunOutcome = 'ok' | 'error' | 'empty' | 'timeout' | 'rejected';

// The job a model request belongs to, carried through async calls (an order's executor makes several gateway requests)
export interface JobContext {
  agent: string; // subagent name, executor kind («homework»), or «gateway»
  leadId?: number;
  taskId?: number;
  orderId?: number;
}

const jobStore = new AsyncLocalStorage<JobContext>();
export const withJob = <T>(job: JobContext, fn: () => Promise<T>): Promise<T> => jobStore.run(job, fn);
export const currentJob = (): JobContext | undefined => jobStore.getStore();

export interface ModelStat {
  model: string;
  agent: string;
  runs: number;
  ok: number; // finished and not turned down by anyone
  failed: number; // error, empty, timeout
  rejected: number; // the verifier turned it down
  redone: number; // the primary agent sent it back
  clientFixes: number; // the client asked to correct it
  avgScore: number | null; // the verifier's average, 0–1
  avgMs: number;
}

export function createLedger(db: Db) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS model_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    model TEXT NOT NULL, -- provider/model
    agent TEXT NOT NULL,
    lead_id INTEGER, task_id INTEGER, order_id INTEGER,
    task TEXT NOT NULL DEFAULT '', -- the job, shortened
    outcome TEXT NOT NULL, -- ok | error | empty | timeout | rejected
    error TEXT,
    score REAL, -- verifier, 0–1
    verdict TEXT, -- verifier's note
    verifier TEXT,
    review TEXT, -- accepted | redo (primary agent)
    client_fix INTEGER NOT NULL DEFAULT 0,
    ms INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS model_runs_model_agent ON model_runs(model, agent);
  CREATE INDEX IF NOT EXISTS model_runs_task ON model_runs(task_id);
  CREATE INDEX IF NOT EXISTS model_runs_order ON model_runs(order_id);`);

  function record(r: {
    model: string; agent: string; outcome: RunOutcome; task?: string; error?: string | null; ms?: number; cost?: number;
    leadId?: number; taskId?: number; orderId?: number;
  }): number {
    const res = db.raw.prepare(`INSERT INTO model_runs(ts, model, agent, lead_id, task_id, order_id, task, outcome, error, ms, cost)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Date.now(), r.model, r.agent, r.leadId ?? null, r.taskId ?? null, r.orderId ?? null, (r.task ?? '').slice(0, 300),
      r.outcome, r.error?.slice(0, 500) ?? null, Math.round(r.ms ?? 0), r.cost ?? 0,
    );
    return Number(res.lastInsertRowid);
  }

  function verdict(runId: number, v: { ok: boolean; score: number; note: string; verifier: string }) {
    db.raw.prepare('UPDATE model_runs SET score = ?, verdict = ?, verifier = ?, outcome = ? WHERE id = ?')
      .run(v.score, v.note.slice(0, 500), v.verifier, v.ok ? 'ok' : 'rejected', runId);
  }

  // The primary agent's review of a background task: the accepted run is the last good one of the task
  function review(taskId: number, value: 'accepted' | 'redo') {
    db.raw.prepare(`UPDATE model_runs SET review = ? WHERE id = (SELECT MAX(id) FROM model_runs WHERE task_id = ? AND outcome = 'ok')`).run(value, taskId);
  }

  // The client asked to fix an order's result: every good run of that order counts it
  function clientFix(orderId: number) {
    db.raw.prepare(`UPDATE model_runs SET client_fix = client_fix + 1 WHERE order_id = ? AND outcome = 'ok'`).run(orderId);
  }

  function stats(sinceMs = 0): ModelStat[] {
    return (db.raw.prepare(`SELECT model, agent, COUNT(*) AS runs,
        SUM(outcome = 'ok' AND COALESCE(review, '') <> 'redo' AND client_fix = 0) AS ok,
        SUM(outcome IN ('error', 'empty', 'timeout')) AS failed,
        SUM(outcome = 'rejected') AS rejected,
        SUM(review = 'redo') AS redone,
        SUM(client_fix > 0) AS clientFixes,
        AVG(score) AS avgScore,
        AVG(ms) AS avgMs
      FROM model_runs WHERE ts >= ? GROUP BY model, agent ORDER BY runs DESC`).all(sinceMs) as any[])
      .map((r) => ({ ...r, avgMs: Math.round(r.avgMs ?? 0), avgScore: r.avgScore == null ? null : Number(r.avgScore) }));
  }

  // How much to trust a model with an agent's jobs: successes over attempts with a neutral prior (0.5 with no history),
  // so a new model gets its chances and a few failures don't bury a good one
  function reliability(agent: string): Map<string, number> {
    const rows = db.raw.prepare(`SELECT model,
        SUM(outcome = 'ok' AND COALESCE(review, '') <> 'redo' AND client_fix = 0) AS good, COUNT(*) AS runs
      FROM model_runs WHERE agent = ? AND ts >= ? GROUP BY model`).all(agent, Date.now() - 30 * 86400_000) as { model: string; good: number; runs: number }[];
    return new Map(rows.map((r) => [r.model, (r.good + 1) / (r.runs + 2)]));
  }

  return { record, verdict, review, clientFix, stats, reliability };
}

export type Ledger = ReturnType<typeof createLedger>;

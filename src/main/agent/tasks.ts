// Background tasks: the primary agent hands work to subagents (researcher, copywriter, directologist…) and answers the
// client at once; up to MAX_PARALLEL tasks run side by side and each result goes to the client by itself.
// The queue lives in the database, so tasks survive a restart.
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppEvent } from '../../shared/types';
import type { Db } from '../db';

export const MAX_PARALLEL = 3;

export type AgentTaskStatus = 'queued' | 'running' | 'done' | 'failed';

export interface AgentTask {
  id: number;
  leadId: number;
  agent: string;
  task: string;
  status: AgentTaskStatus;
  result: string | null;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

export interface TaskFile {
  path: string;
  mime: string;
}

type Row = Record<string, any>;

const toTask = (r: Row): AgentTask => ({
  id: r.id, leadId: r.lead_id, agent: r.agent, task: r.task, status: r.status, result: r.result, error: r.error,
  createdAt: r.created_at, finishedAt: r.finished_at,
});

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', md: 'text/markdown',
  txt: 'text/plain', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};

export function taskDir(dataDir: string, leadId: number, taskId: number): string {
  const dir = join(dataDir, 'clients', String(leadId), 'tasks', String(taskId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface TaskQueue {
  enqueue(leadId: number, agent: string, task: string): AgentTask;
  open(leadId: number): AgentTask[]; // queued or running — the agent must not start the same work twice
  resume(): void;
}

export function createAgentTasks(deps: {
  db: Db;
  dataDir: string;
  emit: (e: AppEvent) => void;
  run: (task: AgentTask, dir: string) => Promise<string>; // the subagent's text result; files it writes go to dir
  deliver: (task: AgentTask, text: string, files: TaskFile[]) => Promise<void>;
  fail: (task: AgentTask, error: string) => Promise<void>;
  maxParallel?: number;
}): TaskQueue {
  const { db } = deps;
  db.raw.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    agent TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_tasks_status ON agent_tasks(status, id);`);
  const limit = deps.maxParallel ?? MAX_PARALLEL;
  let running = 0;
  const get = (id: number) => toTask(db.raw.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id) as Row);
  const set = (id: number, patch: Partial<Record<'status' | 'result' | 'error' | 'finished_at', unknown>>) => {
    for (const [k, v] of Object.entries(patch)) db.raw.prepare(`UPDATE agent_tasks SET ${k} = ? WHERE id = ?`).run(v as never, id);
  };

  async function execute(task: AgentTask) {
    const dir = taskDir(deps.dataDir, task.leadId, task.id);
    try {
      const text = (await deps.run(task, dir)).trim();
      const files = readdirSync(dir)
        .filter((n) => statSync(join(dir, n)).isFile())
        .map((n) => ({ path: join(dir, n), mime: MIME[n.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream' }));
      set(task.id, { status: 'done', result: text, finished_at: Date.now() });
      await deps.deliver(get(task.id), text, files);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      set(task.id, { status: 'failed', error, finished_at: Date.now() });
      await deps.fail(get(task.id), error).catch((e) => console.error('task fail handler', e));
    }
  }

  function pump() {
    while (running < limit) {
      const next = db.raw.prepare("SELECT * FROM agent_tasks WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Row | undefined;
      if (!next) return;
      set(next.id, { status: 'running' });
      running++;
      void execute(toTask({ ...next, status: 'running' })).finally(() => {
        running--;
        pump();
      });
    }
  }

  return {
    enqueue(leadId, agent, task) {
      const res = db.raw.prepare('INSERT INTO agent_tasks(lead_id, agent, task, created_at) VALUES(?, ?, ?, ?)')
        .run(leadId, agent, task, Date.now());
      const created = get(Number(res.lastInsertRowid));
      pump();
      return created;
    },
    open(leadId) {
      return (db.raw.prepare("SELECT * FROM agent_tasks WHERE lead_id = ? AND status IN ('queued', 'running') ORDER BY id")
        .all(leadId) as Row[]).map(toTask);
    },
    // tasks interrupted by a restart run again
    resume() {
      db.raw.prepare("UPDATE agent_tasks SET status = 'queued' WHERE status = 'running'").run();
      pump();
    },
  };
}

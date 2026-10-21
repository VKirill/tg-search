import type { AgentStep } from '../../shared/types';
import type { Db } from '../db';

const TRUNC = 4000;

function trunc(s: string): string {
  return s.length <= TRUNC ? s : s.slice(0, TRUNC) + '…';
}

export function insertAgentStep(
  db: Db,
  row: Omit<AgentStep, 'id'>,
): AgentStep {
  const res = db.raw.prepare(
    'INSERT INTO agent_steps(lead_id, ts, tool, input, output, ok) VALUES(?, ?, ?, ?, ?, ?)',
  ).run(row.leadId, row.ts, row.tool, trunc(row.input), trunc(row.output), Number(row.ok));
  return { ...row, id: Number(res.lastInsertRowid) };
}

export function listAgentSteps(db: Db, leadId: number, limit = 100): AgentStep[] {
  const rows = db.raw.prepare(
    'SELECT * FROM agent_steps WHERE lead_id = ? ORDER BY ts DESC, id DESC LIMIT ?',
  ).all(leadId, limit) as { id: number; lead_id: number; ts: number; tool: string; input: string; output: string; ok: number }[];
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    ts: r.ts,
    tool: r.tool,
    input: r.input,
    output: r.output,
    ok: !!r.ok,
  }));
}

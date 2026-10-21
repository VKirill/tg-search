import type { Approval, AppEvent, ToolPermission } from '../../shared/types';
import type { Db } from '../db';
import type { Operator } from './types';
import { buildApprovalSummary } from './approvalSummary';
import { effectiveToolPermission, PERMISSION_ASK_MSG } from './permissions';
import type { AgentDefsApi } from './defs';
export type RunApprovedTool = (
  tool: string,
  args: Record<string, unknown>,
  leadId: number,
  agentName: string,
) => Promise<string>;

export interface ApprovalsApi {
  list(status?: Approval['status']): Approval[];
  createPending(input: Omit<Approval, 'id' | 'status' | 'createdAt' | 'decidedAt'>): Approval;
  decide(id: number, approve: boolean): Promise<Approval>;
}

export function createApprovals(deps: {
  db: Db;
  emit: (e: AppEvent) => void;
  agents: AgentDefsApi;
  getOperator: () => Operator;
  runTool: RunApprovedTool;
}): ApprovalsApi {
  function rowToApproval(r: Record<string, unknown>): Approval {
    return {
      id: r.id as number,
      leadId: r.lead_id as number,
      agent: r.agent as string,
      tool: r.tool as string,
      input: r.input as string,
      summary: r.summary as string,
      status: r.status as Approval['status'],
      createdAt: r.created_at as number,
      decidedAt: (r.decided_at as number | null) ?? null,
    };
  }

  function list(status?: Approval['status']): Approval[] {
    const rows = status
      ? deps.db.raw.prepare('SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC').all(status)
      : deps.db.raw.prepare('SELECT * FROM approvals ORDER BY created_at DESC').all();
    return (rows as Record<string, unknown>[]).map(rowToApproval);
  }

  function createPending(input: Omit<Approval, 'id' | 'status' | 'createdAt' | 'decidedAt'>): Approval {
    const now = Date.now();
    const res = deps.db.raw
      .prepare(
        `INSERT INTO approvals(lead_id, agent, tool, input, summary, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      )
      .run(input.leadId, input.agent, input.tool, input.input, input.summary, now);
    const r = deps.db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(Number(res.lastInsertRowid)) as Record<
      string,
      unknown
    >;
    const approval = rowToApproval(r);
    deps.emit({ type: 'approval:update', approval });
    return approval;
  }

  async function decide(id: number, approve: boolean): Promise<Approval> {
    const row = deps.db.raw.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error('Согласование не найдено');
    const pending = rowToApproval(row);
    if (pending.status !== 'pending') return pending;
    const now = Date.now();
    const status = approve ? 'approved' : 'denied';
    deps.db.raw.prepare('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?').run(status, now, id);
    const approval: Approval = { ...pending, status: status as Approval['status'], decidedAt: now };
    deps.emit({ type: 'approval:update', approval });

    const leadId = pending.leadId;
    if (!approve) {
      await deps.getOperator().turn(leadId, {
        approvalContinuation: { tool: pending.tool, output: 'Владелец отклонил это действие. Сообщи клиенту тактично и предложи альтернативу.' },
      });
      return approval;
    }

    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(pending.input) as Record<string, unknown>;
    } catch {
      args = {};
    }
    const output = await deps.runTool(pending.tool, args, leadId, pending.agent);
    await deps.getOperator().turn(leadId, {
      approvalContinuation: { tool: pending.tool, output },
    });
    return approval;
  }

  return { list, createPending, decide };
}

export function gateToolCall(
  agentName: string,
  agent: import('../../shared/types').AgentDef,
  tool: string,
  args: Record<string, unknown>,
  ctx: { leadId: number; dryRun: boolean },
  deps: { db: Db; agents: AgentDefsApi; approvals: ApprovalsApi },
): { blocked: true; output: string; ok: boolean } | { blocked: false; permission: ToolPermission } {
  const perm = effectiveToolPermission(agent, tool, args, deps.db);
  if (perm === 'deny') {
    return { blocked: true, output: 'запрещено правилами агента', ok: false };
  }
  if (perm === 'ask') {
    if (!ctx.dryRun) {
      const summary = buildApprovalSummary(deps.db, tool, args);
      deps.approvals.createPending({
        leadId: ctx.leadId,
        agent: agentName,
        tool,
        input: JSON.stringify(args),
        summary,
      });
    }
    return { blocked: true, output: PERMISSION_ASK_MSG, ok: false };
  }
  return { blocked: false, permission: perm };
}

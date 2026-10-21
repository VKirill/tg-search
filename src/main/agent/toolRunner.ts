import { buildAgentTools, freshTurnState } from './tools';
import type { ToolHostDeps } from './tools/deps';
import type { ToolContext } from './types';

/** Run a single tool call (e.g. after owner approval). */
export async function executeApprovedTool(
  toolName: string,
  args: Record<string, unknown>,
  leadId: number,
  _agentName: string,
  host: ToolHostDeps,
): Promise<string> {
  const tools = buildAgentTools(host);
  const tool = tools.find((t) => t.name === toolName);
  if (!tool) return `Ошибка: неизвестный инструмент ${toolName}`;
  const clientId = host.db.raw.prepare('SELECT client_id FROM leads WHERE id = ?').get(leadId) as
    | { client_id: number | null }
    | undefined;
  const ctx: ToolContext = {
    leadId,
    clientId: clientId?.client_id ?? null,
    dryRun: false,
    skipPermission: true,
  };
  try {
    return await tool.run(args, ctx);
  } catch (e) {
    return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function makeToolHost(base: Omit<ToolHostDeps, 'turnState'>): ToolHostDeps {
  return { ...base, turnState: freshTurnState() };
}

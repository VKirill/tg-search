import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { estimatePrice, formatDialog, packageTextOutput } from './shared';
import type { AgentDefsApi } from '../agent/defs';
import { runSubagentTurn } from '../agent/subagent';
import type { ApprovalsApi } from '../agent/approvals';
import type { ToolHostDeps } from '../agent/tools/deps';
import { freshTurnState } from '../agent/tools';

export interface AgentExecutorDeps {
  getSettings: () => Settings;
  agents: AgentDefsApi;
  approvals: ApprovalsApi;
  makeToolHost: (leadId: number) => ToolHostDeps;
  emit: (e: import('../../shared/types').AppEvent) => void;
  db: import('../db').Db;
}

export function createAgentExecutor(deps: AgentExecutorDeps): Executor {
  async function runSubagentForOrder(input: ExecutorInput, task: string): Promise<string> {
    const agentName = input.service.agent?.trim();
    if (!agentName) throw new Error('У услуги не указан агент-исполнитель');
    const context = `Бриф заказа:\n${input.order.brief}\n\nДиалог:\n${formatDialog(input.history)}`;
    const turnState = freshTurnState();
    const host = deps.makeToolHost(input.lead.id);
    const { text } = await runSubagentTurn({
      agentName,
      task,
      context,
      leadId: input.lead.id,
      clientId: input.lead.clientId,
      host: { ...host, turnState },
      agents: deps.agents,
      approvals: deps.approvals,
      db: deps.db,
      emit: deps.emit,
    });
    return text;
  }

  return {
    estimate: (input) => estimatePrice(deps.getSettings, input),

    preview: async (input) => {
      const outline = await runSubagentForOrder(input, `Краткий план (превью) по поручению:\n${input.order.brief}`);
      return packageTextOutput(input.workDir, outline.trim(), 'preview', 'preview-plan.md');
    },

    run: async (input): Promise<ExecutorOutput> => {
      const text = await runSubagentForOrder(input, input.order.brief);
      const path = join(input.workDir, 'result.md');
      await writeFile(path, text, 'utf8');
      return {
        text: text.slice(0, 3500),
        files: [{ path, role: 'output', name: 'result.md', mime: 'text/markdown' }],
      };
    },
  };
}

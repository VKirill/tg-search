import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import type { AgentDefsApi } from '../defs';
import type { ApprovalsApi } from '../approvals';
import { runSubagentTurn } from '../subagent';
import type { Db } from '../../db';
import type { AppEvent } from '../../../shared/types';

export interface DelegateDeps extends ToolHostDeps {
  agents: AgentDefsApi;
  approvals: ApprovalsApi;
  primaryAgent: string;
  clientContext: string;
}

export function createDelegateTool(deps: DelegateDeps): AgentTool {
  return {
    name: 'delegate',
    description:
      'Поручить задачу subagent-у (researcher, copywriter, solver…). Вернуть результат в ответе инструмента.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Имя агента из каталога subagent' },
        task: { type: 'string', description: 'Что сделать' },
      },
      required: ['agent', 'task'],
    },
    async run(args, ctx) {
      const agentName = String(args.agent ?? '').trim();
      const task = String(args.task ?? '').trim();
      if (!agentName || !task) return 'Ошибка: укажите agent и task';
      if (ctx.dryRun) return `[dryRun] Делегировали бы «${agentName}»: ${task.slice(0, 120)}`;
      try {
        const sub = deps.agents.get(agentName);
        if (sub.mode !== 'subagent') return `Ошибка: «${agentName}» не subagent`;
      } catch {
        return `Ошибка: агент «${agentName}» не найден`;
      }
      const { text } = await runSubagentTurn({
        agentName,
        task,
        context: deps.clientContext,
        leadId: ctx.leadId,
        clientId: ctx.clientId,
        host: deps,
        agents: deps.agents,
        approvals: deps.approvals,
        db: deps.db as Db,
        emit: deps.emit,
      });
      return text || '(пустой результат subagent)';
    },
  };
}

import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';

export function createHandoffTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'handoff',
    description: 'Передать диалог живому менеджеру: уведомить владельца и поставить флаг handoff.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Короткая причина на русском' },
        summary: { type: 'string', description: 'Сводка для владельца' },
      },
      required: ['reason', 'summary'],
    },
    async run(args, ctx) {
      const reason = String(args.reason ?? '').trim();
      const summary = String(args.summary ?? '').trim();
      if (!reason) return 'Ошибка: укажите reason';
      deps.turnState.handoff = true;
      deps.turnState.handoffReason = reason;
      deps.turnState.handoffSummary = summary;
      if (ctx.dryRun) return `[dryRun] Передали бы менеджеру: ${reason}`;
      if (!deps.handoff) return 'Ошибка: handoff не настроен';
      await deps.handoff.doHandoff(ctx.leadId, reason, summary, deps.turnState.replyText ?? '');
      return 'Диалог передан менеджеру';
    },
  };
}

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTool } from '../types';
import type { DialogTurn } from '../../ai/types';
import { sendMessage } from '../../pipeline/outreach';
import type { ToolHostDeps } from './deps';

function dialogHistory(deps: ToolHostDeps, leadId: number): DialogTurn[] {
  const lead = deps.db.getLead(leadId);
  const messages = deps.db.listMessages(leadId);
  const turns: DialogTurn[] = [{ direction: 'in', text: lead.text }];
  for (const m of messages) turns.push({ direction: m.direction, text: m.text });
  return turns;
}

export function createRunTaskTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'run_task',
    description:
      'Выполнить поручение ассистента (поиск, исследование). Требует активную подписку с квотой или разовый заказ.',
    parameters: {
      type: 'object',
      properties: { instructions: { type: 'string', description: 'Что нужно сделать' } },
      required: ['instructions'],
    },
    async run(args, ctx) {
      const instructions = String(args.instructions ?? '').trim();
      if (!instructions) return 'Ошибка: пустое поручение';
      if (ctx.clientId == null) return 'Клиент не привязан';
      if (ctx.dryRun) return `[dryRun] Запустили бы ассистента: ${instructions.slice(0, 200)}`;
      if (!deps.billing?.consumeTask(ctx.clientId)) {
        return 'нужна подписка или разовый заказ';
      }
      const services = deps.db.listServices().filter((s) => s.kind === 'assistant' && s.enabled);
      const service = services[0];
      if (!service) return 'Услуга ассистента не настроена';
      if (!deps.executors?.assistant) return 'Исполнитель ассистента не подключён';

      const lead = deps.db.getLead(ctx.leadId);
      const history = dialogHistory(deps, ctx.leadId);
      const brief = `${instructions}\n\n(поручение из диалога)`;
      const dataDir = deps.dataDir ?? join(process.cwd(), 'tmp');
      const workDir = join(dataDir, 'clients', String(ctx.leadId), 'tasks', String(Date.now()));
      mkdirSync(workDir, { recursive: true });

      const order = {
        id: 0,
        leadId: ctx.leadId,
        serviceId: service.id,
        status: 'in_progress' as const,
        price: service.priceMin,
        brief,
        files: [],
        paymentId: null,
        paymentUrl: null,
        paidAt: null,
        result: null,
        revisionsUsed: 0,
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      try {
        const output = await deps.executors.assistant.run({
          service,
          order,
          lead,
          history,
          inputs: [],
          workDir,
          clientPhotoPath: null,
        });
        const text = output.text.trim();
        if (text) await sendMessage(deps, ctx.leadId, text, 'dm', true);
        return text.slice(0, 500) || 'Готово, результат отправлен клиенту';
      } catch (e) {
        return `Ошибка исполнителя: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };
}

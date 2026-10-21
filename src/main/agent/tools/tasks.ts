import { join } from 'node:path';
import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import { writeXlsx, type Sheet } from '../../files/xlsx';
import { isFreeLead } from '../../trusted';

// The primary agent hands bigger work to a subagent in the background and keeps talking to the client
export function createAssignTaskTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'assign_task',
    description:
      'Поручить объёмную работу subagent-у в фоне (исследование, тексты, семантика и объявления для Директа, таблицы Excel). ' +
      'Можно несколько поручений за ход — они идут параллельно; результат с файлами придёт клиенту сам. Сразу после — короткий ответ клиенту.',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'subagent: researcher, copywriter, directologist, solver…' },
        task: { type: 'string', description: 'Полное поручение: что сделать, для кого, в каком виде отдать (например «таблицей Excel»)' },
      },
      required: ['agent', 'task'],
    },
    async run(args, ctx) {
      const agent = String(args.agent ?? '').trim();
      const task = String(args.task ?? '').trim();
      if (!agent || !task) return 'Ошибка: укажите agent и task';
      const tasks = deps.getTasks?.();
      if (!tasks) return 'Ошибка: фоновые поручения не подключены';
      if (ctx.dryRun) return `[dryRun] Поручили бы «${agent}»: ${task.slice(0, 120)}`;
      const lead = deps.db.getLead(ctx.leadId);
      // free for «свои люди»; a paying client spends a subscription task, otherwise it is an order
      if (!isFreeLead(deps.db, lead) && (ctx.clientId == null || !deps.billing?.consumeTask(ctx.clientId))) {
        return 'Ошибка: у клиента нет подписки с квотой — оформи заказ на услугу из каталога';
      }
      const t = tasks.enqueue(ctx.leadId, agent, task);
      const open = tasks.open(ctx.leadId).length;
      return `Поручение #${t.id} у «${agent}» в работе (всего в работе: ${open}); результат придёт клиенту сам. Скажи коротко, что взял и когда примерно скинешь.`;
    },
  };
}

// Subagents produce real Excel files; the file goes to the client together with the task result
export function createMakeXlsxTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'make_xlsx',
    description: 'Сохранить таблицу Excel (.xlsx), она приложится к результату поручения. Первая строка каждого листа — заголовки.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Имя файла без пути, например «semantika-krovat.xlsx»' },
        sheets: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } },
            },
            required: ['name', 'rows'],
          },
        },
      },
      required: ['filename', 'sheets'],
    },
    async run(args) {
      if (!deps.taskDir) return 'Ошибка: таблицы делаются только внутри поручения (assign_task)';
      const sheets = (Array.isArray(args.sheets) ? args.sheets : []) as Sheet[];
      if (!sheets.length || sheets.some((s) => !Array.isArray(s.rows))) return 'Ошибка: нужны sheets с rows';
      const name = String(args.filename ?? 'table').replace(/[^\p{L}\p{N}._ -]/gu, '').replace(/\.xlsx$/i, '') || 'table';
      writeXlsx(join(deps.taskDir, `${name}.xlsx`), sheets);
      return `Файл ${name}.xlsx готов (${sheets.map((s) => `«${s.name}»: ${s.rows.length} строк`).join(', ')})`;
    },
  };
}

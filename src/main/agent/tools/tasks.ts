import { join } from 'node:path';
import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import { writeXlsx, type Sheet } from '../../files/xlsx';
import { isFreeLead } from '../../trusted';
import { sendMediaMessage, waitForSendWindow } from '../../pipeline/outreach';

// The primary agent hands bigger work to a subagent in the background and keeps talking to the client
export function createAssignTaskTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'assign_task',
    description:
      'Поручить объёмную работу subagent-у в фоне (исследование, тексты, семантика и объявления для Директа, таблицы Excel). ' +
      'Можно несколько поручений за ход — они идут параллельно; готовый результат вернётся к тебе на проверку, клиенту его отправишь ' +
      'через send_task_result. Сразу после поручения — короткий ответ клиенту. redo_of — переделать готовое поручение (бесплатно, один раз).',
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'subagent: researcher, copywriter, directologist, solver…' },
        task: { type: 'string', description: 'Полное поручение: что сделать, для кого, в каком виде отдать (например «таблицей Excel»)' },
        redo_of: { type: 'number', description: 'Номер готового поручения, которое надо переделать: что было не так и как исправить — в task' },
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
      const redoOf = args.redo_of == null || args.redo_of === '' ? null : Number(args.redo_of);
      if (redoOf != null) {
        // a redo of our own work is free, and only once: a second miss goes to the owner
        const original = tasks.get(redoOf);
        if (!original || original.leadId !== ctx.leadId || original.status !== 'done') return `Ошибка: готового поручения #${redoOf} в этом диалоге нет`;
        if (original.redoOf != null) return 'Ошибка: это поручение уже переделывали — отправь лучшее через send_task_result или передай владельцу (handoff)';
        if (original.deliveredAt) return `Ошибка: поручение #${redoOf} уже у клиента — для доработки по его просьбе дай новое поручение`;
        tasks.markDelivered(redoOf);
      } else if (!isFreeLead(deps.db, lead) && (ctx.clientId == null || !deps.billing?.consumeTask(ctx.clientId))) {
        // free for «свои люди»; a paying client spends a subscription task, otherwise it is an order
        return 'Ошибка: у клиента нет подписки с квотой — оформи заказ на услугу из каталога';
      }
      const t = tasks.enqueue(ctx.leadId, agent, task, redoOf ?? undefined);
      const open = tasks.open(ctx.leadId).length;
      return redoOf != null
        ? `Поручение #${t.id} переделывает #${redoOf} у «${agent}»; результат снова придёт тебе на проверку.`
        : `Поручение #${t.id} у «${agent}» в работе (всего в работе: ${open}); результат придёт тебе на проверку. Скажи клиенту коротко, что взял и когда примерно скинешь.`;
    },
  };
}

// The checked result of a background task goes to the client as is — formatted, with its files — under a short intro
export function createSendTaskResultTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'send_task_result',
    description:
      'Отправить клиенту проверенный результат готового поручения: текст уйдёт как есть, оформленным сообщением, с файлами. ' +
      'Ты пишешь только короткое живое вступление.',
    parameters: {
      type: 'object',
      properties: {
        task_id: { type: 'number', description: 'Номер готового поручения' },
        intro: { type: 'string', description: 'Вступление в манере style, например «готово, смотри» или «вот, глянь, табличка в файле»' },
      },
      required: ['task_id', 'intro'],
    },
    async run(args, ctx) {
      const tasks = deps.getTasks?.();
      if (!tasks) return 'Ошибка: фоновые поручения не подключены';
      const task = tasks.get(Number(args.task_id));
      if (!task || task.leadId !== ctx.leadId) return `Ошибка: поручения #${args.task_id} в этом диалоге нет`;
      if (task.status !== 'done') return `Ошибка: поручение #${task.id} ещё не готово`;
      if (task.deliveredAt) return `Поручение #${task.id} уже отправлено клиенту`;
      if (ctx.dryRun) return `[dryRun] Отправили бы результат поручения #${task.id}`;
      const intro = String(args.intro ?? '').trim();
      const text = [intro, task.result?.trim()].filter(Boolean).join('\n\n');
      await waitForSendWindow(deps, ctx.leadId); // the agent may have just written «взял» — the pause runs out first
      await sendMediaMessage(deps, ctx.leadId, text, tasks.files(task), true);
      tasks.markDelivered(task.id);
      if (deps.turnState) deps.turnState.replyUsed = true; // the client got this turn's message
      return `Результат поручения #${task.id} отправлен клиенту`;
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

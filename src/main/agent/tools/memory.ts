import type { AgentTool, ToolContext } from '../types';
import type { ToolHostDeps } from './deps';

export function createMemoryTools(deps: ToolHostDeps): AgentTool[] {
  const search: AgentTool = {
    name: 'search_memory',
    description: 'Поиск по памяти клиента: факты, эпизоды, файлы.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!deps.memory) return 'Память клиента пока не подключена';
      if (ctx.clientId == null) return 'Клиент ещё не привязан к лиду';
      if (ctx.dryRun) return `[dryRun] Поиск в памяти: ${query}`;
      const r = deps.memory.search(ctx.clientId, query);
      const facts = r.facts.map((f) => `[${f.kind}] ${f.text}`).join('\n') || '—';
      const eps = r.episodes.map((e) => e.summary).join('\n') || '—';
      const assets = r.assets.map((a) => `#${a.id} ${a.name}: ${a.caption}`).join('\n') || '—';
      return `Факты:\n${facts}\n\nЭпизоды:\n${eps}\n\nФайлы:\n${assets}`;
    },
  };

  const remember: AgentTool = {
    name: 'remember',
    description: 'Сохранить устойчивый факт о клиенте.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['profile', 'preference', 'deal', 'material', 'other'] },
        text: { type: 'string' },
      },
      required: ['kind', 'text'],
    },
    async run(args, ctx) {
      if (!deps.memory) return 'Память клиента пока не подключена';
      if (ctx.clientId == null) return 'Клиент ещё не привязан к лиду';
      const text = String(args.text ?? '').trim();
      const kind = String(args.kind ?? 'other') as import('../../../shared/types').FactKind;
      if (!text) return 'Ошибка: пустой текст';
      if (ctx.dryRun) return `[dryRun] Запомнили бы (${kind}): ${text}`;
      deps.memory.remember(ctx.clientId, kind, text, `lead ${ctx.leadId}`);
      return 'Сохранено';
    },
  };

  return [search, remember];
}

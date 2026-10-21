import type { AgentTool } from '../types';
import { fetchReadableUrl, geminiSearch, tavilySearch, type TavilyResult } from '../web';
import type { ToolHostDeps } from './deps';

export function createWebTools(deps: ToolHostDeps): AgentTool[] {
  const webSearch: AgentTool = {
    name: 'web_search',
    description: 'Поиск в интернете: топ результатов с URL и кратким описанием (Tavily, запасной — Google через Gemini).',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    async run(args, ctx) {
      const query = String(args.query ?? '').trim();
      if (!query) return 'Ошибка: пустой запрос';
      const s = deps.getSettings();
      if (ctx.dryRun) return `[dryRun] Поиск: ${query}`;
      let results: TavilyResult[];
      try {
        results = await tavilySearch(s.tavilyApiKey, query, 5);
      } catch (err) {
        // out of quota (HTTP 432), bad key or no key — Google Search via Gemini
        if (!s.geminiApiKey.trim()) throw err;
        results = await geminiSearch(s.geminiApiKey, query);
      }
      if (!results.length) return 'Ничего не найдено';
      return results
        .map((r, i) => `${i + 1}. ${r.title}${r.url ? `\n${r.url}` : ''}${r.content ? `\n${r.content.slice(0, i === 0 && !r.url ? 3000 : 400)}` : ''}`)
        .join('\n\n');
    },
  };

  const fetchUrl: AgentTool = {
    name: 'fetch_url',
    description: 'Скачать страницу и вернуть читаемый текст (до 20 000 символов), только http(s).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const url = String(args.url ?? '').trim();
      if (!url) return 'Ошибка: пустой URL';
      if (ctx.dryRun) return `[dryRun] fetch ${url}`;
      try {
        const text = await fetchReadableUrl(url);
        return text || '(пустая страница)';
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  return [webSearch, fetchUrl];
}

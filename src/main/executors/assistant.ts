import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chatCompletion } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { estimatePrice, formatDialog, packageTextOutput } from './shared';
import { tavilySearch, fetchReadableUrl } from '../agent/web';

async function research(getSettings: () => Settings, brief: string): Promise<{ text: string; sources: string[] }> {
  const key = getSettings().tavilyApiKey;
  const queries = [brief.slice(0, 200)];
  const ifMore = brief.match(/найди|поставщик|список|исслед/i);
  if (ifMore) queries.push(`${brief} контакты сайт`);

  const seen = new Set<string>();
  const snippets: { url: string; text: string }[] = [];

  for (const q of queries.slice(0, 3)) {
    const hits = await tavilySearch(key, q, 5);
    for (const h of hits) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      snippets.push({ url: h.url, text: h.content });
      if (snippets.length >= 5) break;
    }
  }

  for (const s of snippets.slice(0, 3)) {
    try {
      const page = await fetchReadableUrl(s.url);
      if (page.length > 500) s.text = page.slice(0, 6000);
    } catch {
      // keep snippet from search
    }
  }

  const sources = snippets.map((s) => s.url);
  const corpus = snippets.map((s, i) => `Источник ${i + 1} (${s.url}):\n${s.text.slice(0, 4000)}`).join('\n\n');

  const synthesis = await chatCompletion(
    getSettings,
    [
      {
        role: 'system',
        content:
          'Ты исследователь-ассистент. Синтезируй ответ на русском по материалам ниже. В конце добавь раздел «Источники» со списком URL. Без выдуманных фактов.',
      },
      {
        role: 'user',
        content: `Поручение:\n${brief}\n\nМатериалы:\n${corpus || '(мало данных — опиши ограничения)'}`,
      },
    ],
    { temperature: 0.3 },
  );

  return { text: synthesis.trim(), sources };
}

export function createAssistantExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async (input) => {
      const outline = await chatCompletion(
        getSettings,
        [
          {
            role: 'system',
            content: 'Составь краткий план из 3–5 пунктов на русском (превью поручения). Только текст.',
          },
          { role: 'user', content: `Поручение:\n${input.order.brief}\n\nДиалог:\n${formatDialog(input.history)}` },
        ],
        { temperature: 0.3 },
        input.service.model ? { model: input.service.model } : undefined,
      );
      return packageTextOutput(input.workDir, outline.trim(), 'preview', 'preview-plan.md');
    },

    run: async (input): Promise<ExecutorOutput> => {
      const { text, sources } = await research(getSettings, input.order.brief);
      const path = join(input.workDir, 'research.md');
      const body = `${text}\n\n## Источники\n${sources.map((u) => `- ${u}`).join('\n')}`;
      await writeFile(path, body, 'utf8');
      return {
        text: text.slice(0, 3500),
        files: [{ path, role: 'output', name: 'research.md', mime: 'text/markdown' }],
      };
    },
  };
}

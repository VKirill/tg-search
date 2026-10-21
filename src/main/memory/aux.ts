import type { FactKind, Settings } from '../../shared/types';
import { auxEndpoint } from '../ai/gateway';
import { recordUsage } from '../usage';

const TIMEOUT_MS = 90_000;

export type FetchFn = typeof fetch;

export interface ExtractedFact {
  kind: FactKind;
  text: string;
}

export interface CompactResult {
  summary: string;
  facts: ExtractedFact[];
}

export async function compactDialog(
  settings: Settings,
  lines: string[],
  fetchFn: FetchFn,
): Promise<CompactResult | null> {
  const ep = auxEndpoint(settings, fetchFn, 'fast');
  if (!ep) return null;
  const { base, key } = ep;
  fetchFn = ep.fetchFn;

  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.auxModel,
      stream: false,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'Сжимаешь переписку с клиентом. Ответ — только JSON: {"summary":"5-10 строк на русском","facts":[{"kind":"profile|preference|deal|material|other","text":"..."}]}. ' +
            'Факты — только устойчивые сведения, без догадок.',
        },
        { role: 'user', content: lines.join('\n') },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  recordUsage({
    kind: 'llm',
    model: settings.auxModel,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  });
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { summary?: string; facts?: ExtractedFact[] };
    const summary = String(parsed.summary ?? '').trim();
    if (!summary) return null;
    const facts = (parsed.facts ?? [])
      .map((f) => ({ kind: (f.kind ?? 'other') as FactKind, text: String(f.text ?? '').trim() }))
      .filter((f) => f.text);
    return { summary, facts };
  } catch {
    return null;
  }
}

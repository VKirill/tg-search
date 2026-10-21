import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Settings } from '../../shared/types';
import { recordUsage } from '../usage';

const TIMEOUT_MS = 90_000;

function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

function dataUri(path: string): string {
  const buf = readFileSync(path);
  return `data:${mimeForPath(path)};base64,${buf.toString('base64')}`;
}

export type FetchFn = typeof fetch;

async function visionJson(
  settings: Settings,
  useOperator: boolean,
  path: string,
  fetchFn: FetchFn,
): Promise<{ caption: string; tags: string[] } | null> {
  const base = (useOperator ? settings.operatorBaseUrl : settings.auxBaseUrl).replace(/\/$/, '');
  const key = (useOperator ? settings.operatorApiKey : settings.auxApiKey).trim();
  const model = (useOperator ? settings.operatorModel : settings.auxModel).trim();
  if (!base || !key || !model) return null;

  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                'Опиши изображение для архива клиента: 1–2 предложения на русском (что на картинке, зачем может пригодиться). ' +
                'Ответ — только JSON: {"caption":"...","tags":["тег1","тег2"]} с 3–8 короткими тегами на русском.',
            },
            { type: 'image_url', image_url: { url: dataUri(path) } },
          ],
        },
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
    model,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  });
  const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart < 0 || jsonEnd <= jsonStart) return null;
  try {
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1)) as { caption?: string; tags?: string[] };
    const caption = String(parsed.caption ?? '').trim();
    const tags = Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [];
    if (!caption) return null;
    return { caption, tags };
  } catch {
    return null;
  }
}

export async function captionImage(
  settings: Settings,
  path: string,
  fetchFn: FetchFn = fetch,
): Promise<{ caption: string; tags: string[] }> {
  const fromOp = await visionJson(settings, true, path, fetchFn);
  if (fromOp) return fromOp;
  const fromAux = await visionJson(settings, false, path, fetchFn);
  if (fromAux) return fromAux;
  return { caption: 'Изображение без описания', tags: [] };
}

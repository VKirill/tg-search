import { recordUsage } from '../usage';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import type { OrderFile, Settings } from '../../shared/types';

const IMAGE_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1500;
const RETRY_DELAYS_MS = [500, 2000];

export function textToImageModel(imageModel: string): string {
  const m = imageModel.trim() || 'fal-ai/nano-banana-2/edit';
  if (m.endsWith('/edit')) return m.replace(/\/edit$/, '');
  return m;
}

export function editImageModel(imageModel: string): string {
  const m = imageModel.trim() || 'fal-ai/nano-banana-2/edit';
  if (m.endsWith('/edit')) return m;
  return `${m.replace(/\/$/, '')}/edit`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = await fetch(url, init);
    if (res.ok || !isRetryable(res.status) || attempt >= RETRY_DELAYS_MS.length) return res;
    last = res;
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return last!;
}

export async function fileToDataUri(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

type FalSubmitResponse = {
  request_id?: string;
  status_url?: string;
  response_url?: string;
};

type FalStatusResponse = {
  status?: string;
  response_url?: string;
  error?: string;
};

type FalImageResult = {
  images?: { url?: string; content_type?: string; file_name?: string }[];
};

function mimeFromUrl(url: string, contentType?: string): string {
  if (contentType?.startsWith('image/')) return contentType;
  const lower = url.toLowerCase();
  if (lower.includes('.jpg') || lower.includes('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

/** Queue submit → poll → download images into workDir. Exported for tests. */
export async function falRunImageJob(
  settings: Settings,
  model: string,
  body: Record<string, unknown>,
  workDir: string,
  namePrefix: string,
): Promise<OrderFile[]> {
  const falKey = settings.falKey.trim();
  if (!falKey) throw new Error('Укажите ключ fal.ai в настройках');

  await mkdir(workDir, { recursive: true });

  const submitRes = await fetchWithRetry(`https://queue.fal.run/${model}`, {
    method: 'POST',
    headers: {
      Authorization: `Key ${falKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!submitRes.ok) {
    const excerpt = (await submitRes.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
    throw new Error(`Ошибка генерации изображения: HTTP ${submitRes.status}${excerpt ? ` — ${excerpt}` : ''}`);
  }

  const submit = (await submitRes.json()) as FalSubmitResponse;
  const statusUrl = submit.status_url;
  const responseUrl = submit.response_url;
  if (!statusUrl || !responseUrl) throw new Error('Ошибка генерации изображения: нет URL очереди');

  const deadline = Date.now() + IMAGE_TIMEOUT_MS;
  let finalResponseUrl = responseUrl;
  while (Date.now() < deadline) {
    const statusRes = await fetchWithRetry(statusUrl, {
      headers: { Authorization: `Key ${falKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!statusRes.ok) {
      const excerpt = (await statusRes.text()).slice(0, 120).replace(/\s+/g, ' ').trim();
      throw new Error(`Ошибка генерации изображения: статус HTTP ${statusRes.status}${excerpt ? ` — ${excerpt}` : ''}`);
    }
    const status = (await statusRes.json()) as FalStatusResponse;
    if (status.response_url) finalResponseUrl = status.response_url;
    if (status.status === 'COMPLETED') {
      if (status.error) throw new Error(`Ошибка генерации изображения: ${status.error}`);
      break;
    }
    if (status.status === 'FAILED') throw new Error('Ошибка генерации изображения: задание не выполнено');
    await sleep(POLL_INTERVAL_MS);
  }

  const resultRes = await fetchWithRetry(finalResponseUrl, {
    headers: { Authorization: `Key ${falKey}` },
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });
  if (!resultRes.ok) {
    throw new Error(`Ошибка генерации изображения: не удалось получить результат (HTTP ${resultRes.status})`);
  }
  const result = (await resultRes.json()) as FalImageResult;
  const images = result.images ?? [];
  if (!images.length) throw new Error('Ошибка генерации изображения: пустой ответ');

  const files: OrderFile[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img.url) continue;
    const imgRes = await fetchWithRetry(img.url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!imgRes.ok) throw new Error('Ошибка генерации изображения: не удалось скачать файл');
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const mime = mimeFromUrl(img.url, img.content_type);
    const ext = mime === 'image/jpeg' ? '.jpg' : '.png';
    const name = `${namePrefix}-${i + 1}${ext}`;
    const path = join(workDir, name);
    await writeFile(path, buf);
    files.push({ path, role: 'output', name: basename(path), mime });
  }
  if (!files.length) throw new Error('Ошибка генерации изображения: не удалось сохранить файлы');
  return files;
}

export async function generateImages(
  getSettings: () => Settings,
  workDir: string,
  opts: {
    prompt: string;
    referencePaths?: string[];
    count?: number;
    namePrefix: string;
    role: 'output' | 'preview';
  },
): Promise<OrderFile[]> {
  const settings = getSettings();
  const refs = opts.referencePaths ?? [];
  const useEdit = refs.length > 0;
  const model = useEdit ? editImageModel(settings.imageModel) : textToImageModel(settings.imageModel);
  const image_urls = useEdit ? await Promise.all(refs.map((p) => fileToDataUri(p))) : undefined;

  const body: Record<string, unknown> = {
    prompt: opts.prompt,
    num_images: opts.count ?? 1,
    output_format: 'png',
  };
  if (image_urls?.length) body.image_urls = image_urls;

  const raw = await falRunImageJob(settings, model, body, workDir, opts.namePrefix);
  recordUsage({ kind: 'image', model, units: raw.length });
  return raw.map((f) => ({ ...f, role: opts.role }));
}

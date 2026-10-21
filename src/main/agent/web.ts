import { isIP } from 'node:net';

const MAX_FETCH_CHARS = 20_000;
const FETCH_TIMEOUT_MS = 25_000;

export type TavilyResult = { title: string; url: string; content: string };

export async function tavilySearch(apiKey: string, query: string, maxResults = 5): Promise<TavilyResult[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('Укажите ключ Tavily в настройках');
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: 'basic',
      max_results: maxResults,
      include_answer: false,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const excerpt = (await res.text()).slice(0, 150);
    throw new Error(`Tavily: HTTP ${res.status} ${excerpt}`);
  }
  const data = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
  return (data.results ?? []).map((r) => ({
    title: String(r.title ?? '').trim(),
    url: String(r.url ?? '').trim(),
    content: String(r.content ?? '').trim(),
  }));
}

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (isIP(h)) {
    if (h === '127.0.0.1' || h === '0.0.0.0') return true;
    if (h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
    if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  }
  return false;
}

export function assertPublicHttpUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Некорректный URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Разрешены только http(s) URL');
  if (isPrivateHost(u.hostname)) throw new Error('Запрещён доступ к локальным адресам');
  return u;
}

function stripHtml(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length <= MAX_FETCH_CHARS ? s : s.slice(0, MAX_FETCH_CHARS) + '…';
}

export async function fetchReadableUrl(url: string): Promise<string> {
  const u = assertPublicHttpUrl(url);
  const res = await fetch(u.toString(), {
    method: 'GET',
    headers: { 'User-Agent': 'TG-Search-Agent/1.0', Accept: 'text/html,application/xhtml+xml,text/plain' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (ct.includes('html')) return stripHtml(text);
  const plain = text.replace(/\s+/g, ' ').trim();
  return plain.length <= MAX_FETCH_CHARS ? plain : plain.slice(0, MAX_FETCH_CHARS) + '…';
}

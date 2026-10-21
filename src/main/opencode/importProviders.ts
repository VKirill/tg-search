// Where the AI engine's providers come from: keys the app already has (OpenRouter, DeepSeek, Z.ai, the auxiliary
// 9router endpoint) and, on request, the user's own OpenCode config (v1 or v2 format) with its auth.json keys.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../../shared/types';
import type { ProviderConfig, ProviderModel } from './config';

// JSONC → JSON: comments and trailing commas
export function parseJsonc(src: string): any {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const resolveKey = (v: unknown): string | undefined => {
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const env = /^\{env:([A-Z0-9_]+)\}$/i.exec(v.trim());
  if (env) return process.env[env[1]] || undefined;
  if (/^\{file:/.test(v)) return undefined; // a file reference of another config: not followed
  return v.trim();
};

function modelFrom(id: string, m: any): ProviderModel {
  const input: string[] = m?.capabilities?.input ?? m?.modalities?.input ?? [];
  return {
    id: String(m?.modelID ?? m?.id ?? id),
    name: String(m?.name ?? id),
    vision: input.includes('image') || m?.attachment === true,
    tools: m?.capabilities?.tools ?? m?.tool_call ?? true,
    context: Number(m?.limit?.context ?? 128_000),
    output: Number(m?.limit?.output ?? 16_000),
    reasoning: Array.isArray(m?.variants) ? m.variants.map((v: any) => String(v.id)) : m?.variants && typeof m.variants === 'object' ? Object.keys(m.variants) : [],
  };
}

// The user's OpenCode: custom providers from opencode.json(c) and keys from auth.json
export function importFromUserOpencode(home = homedir()): ProviderConfig[] {
  const dir = join(home, '.config', 'opencode');
  const file = ['opencode.jsonc', 'opencode.json'].map((f) => join(dir, f)).find(existsSync);
  const out = new Map<string, ProviderConfig>();
  if (file) {
    const cfg = parseJsonc(readFileSync(file, 'utf8'));
    const providers = cfg.providers ?? cfg.provider ?? {};
    for (const [id, p] of Object.entries<any>(providers)) {
      const settings = p.settings ?? p.options ?? {};
      const models = Object.entries<any>(p.models ?? {}).map(([mid, m]) => modelFrom(mid, m));
      if (settings.baseURL && models.length) {
        out.set(id, { id, name: String(p.name ?? id), kind: 'openai-compatible', baseURL: String(settings.baseURL), apiKey: resolveKey(settings.apiKey), models });
      }
    }
  }
  const auth = join(home, '.local', 'share', 'opencode', 'auth.json');
  if (existsSync(auth)) {
    for (const [id, a] of Object.entries<any>(JSON.parse(readFileSync(auth, 'utf8')))) {
      if (a?.type !== 'api' || !a.key) continue;
      const known = out.get(id);
      if (known) known.apiKey ??= String(a.key);
      else out.set(id, { id, name: id, kind: 'catalog', apiKey: String(a.key) });
    }
  }
  return [...out.values()];
}

// Keys the app had before OpenCode
export function providersFromSettings(s: Settings): ProviderConfig[] {
  const out: ProviderConfig[] = [];
  if (s.llmApiKey.trim() && /openrouter\.ai/.test(s.llmBaseUrl)) out.push({ id: 'openrouter', name: 'OpenRouter', kind: 'catalog', apiKey: s.llmApiKey.trim() });
  if (s.deepseekApiKey.trim()) out.push({ id: 'deepseek', name: 'DeepSeek', kind: 'catalog', apiKey: s.deepseekApiKey.trim() });
  if (s.glmApiKey.trim()) out.push({ id: 'zai-coding-plan', name: 'Z.ai (GLM)', kind: 'catalog', apiKey: s.glmApiKey.trim() });
  if (s.auxBaseUrl.trim() && s.auxApiKey.trim() && s.auxModel.trim()) {
    out.push({
      id: 'router9', name: '9router', kind: 'openai-compatible', baseURL: s.auxBaseUrl.trim(), apiKey: s.auxApiKey.trim(),
      models: [{ id: s.auxModel.trim(), name: s.auxModel.trim(), vision: true, tools: true, context: 1_048_576, output: 65_536, reasoning: [] }],
    });
  }
  return out;
}

// Later lists win on conflicts, but a key is never lost to an entry without one
export function mergeProviders(...lists: ProviderConfig[][]): ProviderConfig[] {
  const out = new Map<string, ProviderConfig>();
  for (const list of lists) {
    for (const p of list) {
      const prev = out.get(p.id);
      out.set(p.id, prev ? { ...prev, ...p, apiKey: p.apiKey ?? prev.apiKey, models: p.models?.length ? p.models : prev.models } : p);
    }
  }
  return [...out.values()];
}

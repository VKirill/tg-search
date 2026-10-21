// Agent definitions (opencode-style markdown + YAML front matter) and company RULES.md.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentDef, ToolPermission } from '../../shared/types';

const BUILTIN_NAMES = ['manager', 'researcher', 'copywriter', 'solver'] as const;

export function defaultShippedAgentsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../../../agents');
}

export interface AgentDefsApi {
  list(): AgentDef[];
  get(name: string): AgentDef;
  save(def: AgentDef): AgentDef;
  remove(name: string): void;
  rules(): string;
  saveRules(text: string): string;
  shippedDir: string;
  userAgentsDir: string;
}

export function createAgentDefs(dataDir: string, shippedDir = defaultShippedAgentsDir()): AgentDefsApi {
  const userAgentsDir = join(dataDir, 'agents');
  const userRulesPath = join(dataDir, 'RULES.md');
  const shippedRulesPath = join(shippedDir, 'RULES.md');

  function ensureDirs() {
    mkdirSync(userAgentsDir, { recursive: true });
  }

  function readShipped(name: string): AgentDef | null {
    const path = join(shippedDir, `${name}.md`);
    if (!existsSync(path)) return null;
    return parseAgentFile(name, readFileSync(path, 'utf8'), true);
  }

  function readUser(name: string): AgentDef | null {
    const path = join(userAgentsDir, `${name}.md`);
    if (!existsSync(path)) return null;
    return parseAgentFile(name, readFileSync(path, 'utf8'), BUILTIN_NAMES.includes(name as (typeof BUILTIN_NAMES)[number]));
  }

  function get(name: string): AgentDef {
    const user = readUser(name);
    if (user) return user;
    const shipped = readShipped(name);
    if (shipped) return shipped;
    throw new Error(`Агент «${name}» не найден`);
  }

  function list(): AgentDef[] {
    const names = new Set<string>(BUILTIN_NAMES);
    ensureDirs();
    for (const f of readdirSync(userAgentsDir)) {
      if (f.endsWith('.md')) names.add(f.slice(0, -3));
    }
    for (const f of readdirSync(shippedDir)) {
      if (f.endsWith('.md') && f !== 'RULES.md') names.add(f.slice(0, -3));
    }
    return [...names].sort().map((n) => get(n));
  }

  function save(def: AgentDef): AgentDef {
    ensureDirs();
    const body = serializeAgentFile(def);
    writeFileSync(join(userAgentsDir, `${def.name}.md`), body, 'utf8');
    return get(def.name);
  }

  function remove(name: string): void {
    const path = join(userAgentsDir, `${name}.md`);
    if (existsSync(path)) unlinkSync(path);
    if (!BUILTIN_NAMES.includes(name as (typeof BUILTIN_NAMES)[number])) return;
    const shipped = join(shippedDir, `${name}.md`);
    if (existsSync(shipped)) {
      ensureDirs();
      copyFileSync(shipped, path);
    }
  }

  function rules(): string {
    if (existsSync(userRulesPath)) return readFileSync(userRulesPath, 'utf8');
    if (existsSync(shippedRulesPath)) return readFileSync(shippedRulesPath, 'utf8');
    return '';
  }

  function saveRules(text: string): string {
    writeFileSync(userRulesPath, text, 'utf8');
    return text;
  }

  return { list, get, save, remove, rules, saveRules, shippedDir, userAgentsDir };
}

/** Split `---` front matter and body (opencode / SKILL style). */
export function splitFrontMatter(raw: string): { front: string; body: string } {
  const trimmed = raw.replace(/\r\n/g, '\n');
  if (!trimmed.startsWith('---\n')) return { front: '', body: trimmed.trim() };
  const end = trimmed.indexOf('\n---\n', 4);
  if (end < 0) return { front: '', body: trimmed.trim() };
  return { front: trimmed.slice(4, end), body: trimmed.slice(end + 5).trim() };
}

function parseScalar(value: string): string | number | boolean {
  const v = value.trim();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Flat YAML keys + nested `permission:` map (no external parser). */
export function parseFrontMatter(front: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = front.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const keyMatch = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (!keyMatch) {
      i++;
      continue;
    }
    const key = keyMatch[1];
    const rest = keyMatch[2];
    if (key === 'permission' && rest === '') {
      const perm: Record<string, ToolPermission> = {};
      i++;
      while (i < lines.length) {
        const pl = lines[i];
        const pm = /^\s{2}([^:]+):\s*(\w+)\s*$/.exec(pl);
        if (!pm) break;
        const p = pm[2] as ToolPermission;
        const key = pm[1].trim().replace(/^["']|["']$/g, '');
        if (p === 'allow' || p === 'ask' || p === 'deny') perm[key] = p;
        i++;
      }
      out.permission = perm;
      continue;
    }
    if (rest === '') {
      i++;
      continue;
    }
    out[key] = parseScalar(rest);
    i++;
  }
  return out;
}

export function parseAgentFile(name: string, raw: string, builtIn: boolean): AgentDef {
  const { front, body } = splitFrontMatter(raw);
  const meta = parseFrontMatter(front);
  const permission = (meta.permission as Record<string, ToolPermission>) ?? { '*': 'allow' };
  const mode = meta.mode === 'subagent' ? 'subagent' : 'primary';
  const temp = meta.temperature;
  return {
    name,
    description: String(meta.description ?? ''),
    mode,
    model: String(meta.model ?? ''),
    temperature: temp === null || temp === undefined ? null : Number(temp),
    steps: Math.max(1, Number(meta.steps ?? 8)),
    needs: (Array.isArray(meta.needs) ? meta.needs.map(String) : String(meta.needs ?? '').split(',')).map((x) => x.trim()).filter(Boolean),
    permission,
    prompt: body,
    builtIn,
  };
}

function serializeAgentFile(def: AgentDef): string {
  const lines = [
    '---',
    `description: ${def.description}`,
    `mode: ${def.mode}`,
    `model: ${def.model}`,
    `temperature: ${def.temperature ?? ''}`,
    `steps: ${def.steps}`,
    ...(def.needs?.length ? [`needs: ${def.needs.join(', ')}`] : []),
    'permission:',
  ];
  for (const [k, v] of Object.entries(def.permission)) {
    lines.push(`  ${k}: ${v}`);
  }
  lines.push('---', def.prompt);
  return lines.join('\n') + '\n';
}

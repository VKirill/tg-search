import type { SkillDef } from '../../shared/types';

const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/;

export function validateSkillName(name: string): string | null {
  const n = name.trim();
  if (!n || n.length > 64) return 'name must be 1–64 characters';
  if (!NAME_RE.test(n)) return 'name must be lowercase letters, digits and hyphens';
  return null;
}

function parseSimpleYaml(fm: string): Record<string, string> {
  const out: Record<string, string> = {};
  let section = '';
  for (const line of fm.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    const m = line.trim().match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2].replace(/^['"]|['"]$/g, '').trim();
    if (indent === 0 && key === 'metadata') {
      section = 'metadata';
      continue;
    }
    if (section === 'metadata' && indent >= 2) {
      out[`metadata.${key}`] = val;
      continue;
    }
    if (indent === 0) {
      section = '';
      out[key] = val;
    }
  }
  return out;
}

export function parseSkillMd(raw: string): Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'> {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error('SKILL.md must start with YAML front matter');
  const fields = parseSimpleYaml(m[1]);
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  let status: SkillDef['status'] = 'active';
  const st = fields['metadata.status'];
  if (st === 'active' || st === 'draft' || st === 'disabled') status = st;
  let source: SkillDef['source'] = 'owner';
  const src = fields['metadata.source'];
  if (src === 'builtin' || src === 'owner' || src === 'learned') source = src;
  const body = m[2].replace(/^\s+/, '');
  const nameErr = validateSkillName(name);
  if (nameErr) throw new Error(nameErr);
  if (!description.trim()) throw new Error('front matter: description is required');
  if (description.length > 1024) throw new Error('description must be at most 1024 characters');
  return { name, description: description.trim(), body, status, source };
}

export function serializeSkillMd(skill: Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'>): string {
  const esc = (s: string) => (s.includes('\n') || s.includes(':') ? JSON.stringify(s) : s);
  return `---
name: ${esc(skill.name)}
description: ${esc(skill.description)}
metadata:
  status: ${skill.status}
  source: ${skill.source}
---

${skill.body.replace(/\s+$/, '')}
`;
}

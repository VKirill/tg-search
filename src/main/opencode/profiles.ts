// What each model is good at. OpenRouter publishes a description, modalities and parameters for every model; once a
// day the main model reads the descriptions of the free (and ticked OpenRouter) models and scores them on the skills
// agents ask for (`needs` in an agent file). The router then gives a job to the free model that fits it best.
import { createHash } from 'node:crypto';
import type { Db } from '../db';
import { parseJsonFromLlm } from '../ai/llm';
import { MODEL_SKILLS } from '../../shared/types';

export type Skill = keyof typeof MODEL_SKILLS;
export const SKILLS = Object.keys(MODEL_SKILLS) as Skill[];
export const SKILL_LABELS: Record<Skill, string> = MODEL_SKILLS;

export interface ModelProfile {
  skills: Partial<Record<Skill, number>>; // 0–3
  summary: string; // one line in Russian for Settings
  expiresAt: number | null; // OpenRouter retires the free variant at this time
}

export interface OpenRouterMeta {
  id: string;
  name: string;
  description: string;
  input: string[];
  params: string[];
  context: number;
  expiresAt: number | null;
}

const MODELS_URL = 'https://openrouter.ai/api/v1/models';

// The public catalog (no key): metadata only, no model is called
export async function fetchOpenRouterMeta(fetchFn: typeof fetch = fetch): Promise<OpenRouterMeta[]> {
  const res = await fetchFn(MODELS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const body = (await res.json()) as { data: any[] };
  return body.data.map((m) => ({
    id: String(m.id),
    name: String(m.name ?? m.id),
    description: String(m.description ?? ''),
    input: m.architecture?.input_modalities ?? [],
    params: m.supported_parameters ?? [],
    context: Number(m.context_length ?? 0),
    expiresAt: m.expiration_date ? Date.parse(m.expiration_date) || null : null,
  }));
}

const hashOf = (m: OpenRouterMeta) => createHash('sha1').update(`${m.description}|${m.input}|${m.params}`).digest('hex').slice(0, 16);

export function createProfiles(db: Db) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS model_profiles (
    ref TEXT PRIMARY KEY, -- provider/model
    hash TEXT NOT NULL, -- of the metadata the profile was made from
    profile TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  const cache = new Map<string, ModelProfile>();
  for (const r of db.raw.prepare('SELECT ref, profile FROM model_profiles').all() as { ref: string; profile: string }[]) {
    try {
      cache.set(r.ref, JSON.parse(r.profile));
    } catch {
      /* rebuilt on the next refresh */
    }
  }

  // Score the models whose metadata is new or changed; `ask` is a one-shot model request returning text
  async function refresh(metas: OpenRouterMeta[], ask: (prompt: string) => Promise<string>, batch = 12): Promise<number> {
    const known = new Map((db.raw.prepare('SELECT ref, hash FROM model_profiles').all() as { ref: string; hash: string }[]).map((r) => [r.ref, r.hash]));
    const stale = metas.filter((m) => known.get(`openrouter/${m.id}`) !== hashOf(m));
    let done = 0;
    for (let i = 0; i < stale.length; i += batch) {
      const part = stale.slice(i, i + batch);
      const raw = await ask(scorePrompt(part));
      const scored = parseJsonFromLlm(raw) as Record<string, { skills?: Record<string, number>; summary?: string }>;
      for (const m of part) {
        const s = scored[m.id];
        if (!s) continue;
        const skills: Partial<Record<Skill, number>> = {};
        for (const k of SKILLS) {
          const v = Number(s.skills?.[k]);
          if (Number.isFinite(v)) skills[k] = Math.max(0, Math.min(3, Math.round(v)));
        }
        if (!m.input.includes('image')) skills.vision = 0; // facts beat the guess
        const profile: ModelProfile = { skills, summary: String(s.summary ?? '').trim().slice(0, 200), expiresAt: m.expiresAt };
        const ref = `openrouter/${m.id}`;
        db.raw.prepare('INSERT OR REPLACE INTO model_profiles(ref, hash, profile, updated_at) VALUES(?, ?, ?, ?)')
          .run(ref, hashOf(m), JSON.stringify(profile), Date.now());
        cache.set(ref, profile);
        done++;
      }
    }
    return done;
  }

  return { get: (ref: string) => cache.get(ref), all: () => cache, refresh };
}

export type Profiles = ReturnType<typeof createProfiles>;

export function scorePrompt(models: OpenRouterMeta[]): string {
  const list = models.map((m) => [
    `id: ${m.id}`,
    `name: ${m.name}`,
    `input: ${m.input.join(', ') || 'text'}; tools: ${m.params.includes('tools') ? 'yes' : 'no'}; reasoning: ${m.params.includes('reasoning') ? 'yes' : 'no'}; context: ${m.context}`,
    `description: ${m.description.slice(0, 1500)}`,
  ].join('\n')).join('\n\n');
  return [
    'Оцени модели по описаниям их авторов. Для каждой поставь навыки от 0 до 3 (0 — не умеет или не для этого, 3 — сильная сторона):',
    'reasoning — логика, математика, решение задач; code — программирование; writing — тексты, копирайтинг, стиль;',
    'russian — русский язык (мультиязычность, качество на русском); vision — понимание картинок и документов-сканов;',
    'agentic — вызов инструментов, многошаговые задачи; research — длинные документы, факты, извлечение данных; speed — быстрая и лёгкая.',
    'Опирайся только на описание и параметры; если про навык ничего не сказано — ставь 1, для крошечных моделей и моделей модерации — 0.',
    'summary — одна строка по-русски: для чего модель лучше всего (до 100 символов).',
    'Ответ — только JSON-объект: {"<id>": {"skills": {"reasoning": 2, …}, "summary": "…"}, …}',
    '',
    list,
  ].join('\n');
}

// How well a model fits a job: the sum of its scores on the skills the job needs (null — no profile)
export function fitScore(profile: ModelProfile | undefined, needs: Skill[]): number | null {
  if (!profile) return null;
  return needs.reduce((s, n) => s + (profile.skills[n] ?? 1), 0);
}

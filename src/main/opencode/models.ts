// Which OpenCode model does what. The owner picks the main chat model and ticks helper models in Settings; the app
// routes each job by what it needs (tools, vision) and how hard it is, and sets the reasoning level (variant).
import type { ModelRef } from './session';
import { fitScore, type ModelProfile, type Skill } from './profiles';

export type ModelRole = 'chat' | 'fast' | 'vision' | 'smart';

export interface CatalogModel {
  providerID: string;
  id: string;
  name: string;
  vision: boolean;
  tools: boolean;
  variants: string[];
  costIn: number; // USD per 1M tokens
  costOut: number;
  context: number;
  enabled: boolean;
}

export const refString = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`;

export function parseRef(ref: string): { providerID: string; id: string } | null {
  const i = ref.indexOf('/');
  return i > 0 ? { providerID: ref.slice(0, i), id: ref.slice(i + 1) } : null;
}

// A role's reasoning level: quick jobs think little, hard ones think more; only levels the model supports
const EFFORT: Record<ModelRole, string[]> = {
  chat: ['medium', 'low'],
  fast: ['low', 'minimal', 'none', 'medium'],
  vision: ['medium', 'low', 'thinking'],
  smart: ['high', 'xhigh', 'thinking', 'medium'],
};

// OpenRouter's free models («…:free») cost nothing. Its routers (free, auto, fusion…) are not models: they pick one we
// can't see or control, so they are never used.
export const isFreeModel = (m: { providerID: string; id: string }) => m.providerID === 'openrouter' && m.id.endsWith(':free');

// Parameters in billions from the id («nemotron-3-ultra-550b-a55b» → 550, «gemma-4-31b-it» → 31); unknown → 0
export function sizeB(id: string): number {
  const sizes = [...id.toLowerCase().matchAll(/(?<![a-z\d.])(\d+(?:\.\d+)?)b(?![a-z])/g)].map((m) => Number(m[1]));
  return sizes.length ? Math.max(...sizes) : 0;
}

const UNFIT_FREE = /safety|guard|lyria|embed/i;
const QUICK = /flash|lightning|small|mini|nano|lite/i;
const THINKS = ['high', 'xhigh', 'max', 'thinking'];

// What a job needs when its agent says nothing
export const ROLE_NEEDS: Record<ModelRole, Skill[]> = {
  chat: ['russian', 'agentic'],
  fast: ['speed', 'russian'],
  vision: ['vision'],
  smart: ['reasoning'],
};

// Free models for a job, best first: by the profile from the model's description (how well it covers the job's needs);
// a model without a profile yet is placed by its name — size, reasoning levels, «flash»-like speed.
function rankFree(free: CatalogModel[], role: ModelRole, needs: Skill[], profile: (ref: string) => ModelProfile | undefined): CatalogModel[] {
  const size = (m: CatalogModel) => sizeB(m.id) || 100;
  const now = Date.now();
  const usable = free.filter((m) => {
    const p = profile(refString(m));
    if (UNFIT_FREE.test(m.id) || size(m) < 8 || (p?.expiresAt && p.expiresAt < now)) return false;
    if (!p) return role !== 'smart' || (size(m) >= 25 && m.variants.some((v) => THINKS.includes(v)));
    if (needs.some((n) => p.skills[n] === 0)) return false; // can't do a part of the job
    return role !== 'smart' || (p.skills.reasoning ?? 0) >= 2;
  });
  let byName: CatalogModel[];
  if (role === 'smart') byName = [...usable].sort((a, b) => Number(QUICK.test(a.id)) - Number(QUICK.test(b.id)) || size(b) - size(a));
  else if (role === 'fast') byName = [...usable].sort((a, b) => Number(QUICK.test(b.id)) - Number(QUICK.test(a.id)) || size(a) - size(b));
  else byName = [...usable].sort((a, b) => size(b) - size(a));
  const neutral = needs.length * 1.5; // an unprofiled model counts as average
  const fit = (m: CatalogModel) => fitScore(profile(refString(m)), needs) ?? neutral;
  return byName.map((m, i) => ({ m, i, f: fit(m) })).sort((a, b) => b.f - a.f || a.i - b.i).map((x) => x.m);
}

function variantFor(m: CatalogModel, role: ModelRole): string | undefined {
  return EFFORT[role].find((v) => m.variants.includes(v));
}

export interface RouteOptions {
  useFree?: boolean; // OpenRouter's free models go first for helper jobs
  cooling?: (ref: string) => boolean; // failed recently (rate limit, error): tried last
  needs?: Skill[]; // what the job needs (the agent's `needs`); the role's default otherwise
  profile?: (ref: string) => ModelProfile | undefined; // what a model is good at, from its description
}

// Every model that can do the job, in the order to try them. Client chat stays on the main model (the owner's
// choice); helper jobs try free models first, then the ticked ones — cheapest for quick jobs, strongest for hard ones.
export function rankModels(
  catalog: CatalogModel[],
  choice: { main: string; helpers: string[] },
  role: ModelRole,
  need: { tools?: boolean; vision?: boolean } = {},
  opts: RouteOptions = {},
): ModelRef[] {
  const byRef = new Map(catalog.map((m) => [refString(m), m]));
  const main = byRef.get(choice.main);
  const wantsVision = need.vision || role === 'vision';
  const fit = (m: CatalogModel | undefined): m is CatalogModel => !!m && m.enabled && (!need.tools || m.tools) && (!wantsVision || m.vision);
  const ticked = [main, ...choice.helpers.map((r) => byRef.get(r))].filter(fit);
  const price = (m: CatalogModel) => m.costIn + m.costOut * 3;
  let paid: CatalogModel[];
  if (role === 'chat') paid = [...ticked].sort((a, b) => Number(b === main) - Number(a === main) || price(b) - price(a));
  else if (role === 'smart') paid = [...ticked].sort((a, b) => price(b) - price(a)); // the strongest is usually the priciest
  else paid = [...ticked].sort((a, b) => price(a) - price(b)); // quick jobs and vision: the cheapest first
  const cooling = opts.cooling ?? (() => false);
  // a few free models that are not resting, so a paid one is always within the attempts
  const free = opts.useFree && role !== 'chat'
    ? rankFree(catalog.filter((m) => fit(m) && isFreeModel(m)), role, opts.needs?.length ? opts.needs : ROLE_NEEDS[role], opts.profile ?? (() => undefined)).filter((m) => !cooling(refString(m))).slice(0, role === 'smart' ? 2 : 3)
    : [];
  const order = [...new Set([...free, ...paid])];
  const ready = [...order.filter((m) => !cooling(refString(m))), ...order.filter((m) => cooling(refString(m)))];
  if (!ready.length && main && (!wantsVision || main.vision)) ready.push(main);
  return ready.map((m) => ({ providerID: m.providerID, id: m.id, variant: variantFor(m, role) }));
}

export function pickModel(
  catalog: CatalogModel[],
  choice: { main: string; helpers: string[] },
  role: ModelRole,
  need: { tools?: boolean; vision?: boolean } = {},
  opts: RouteOptions = {},
): ModelRef {
  const first = rankModels(catalog, choice, role, need, opts)[0];
  if (first) return first;
  throw new Error(need.vision || role === 'vision'
    ? 'Нет модели со зрением: отметьте в настройках ИИ хотя бы одну модель, которая видит картинки'
    : 'Не выбрана основная модель ИИ — выберите её в настройках');
}

// GET /api/model → our catalog shape
export function toCatalog(data: any[], configured: Set<string>): CatalogModel[] {
  return data
    .filter((m) => configured.has(m.providerID) && m.status !== 'deprecated')
    .map((m) => ({
      providerID: m.providerID,
      id: m.id,
      name: m.name ?? m.id,
      vision: Array.isArray(m.capabilities?.input) && m.capabilities.input.includes('image'),
      tools: m.capabilities?.tools !== false,
      variants: Array.isArray(m.variants) ? m.variants.map((v: { id: string }) => v.id) : [],
      costIn: Number(m.cost?.[0]?.input ?? 0),
      costOut: Number(m.cost?.[0]?.output ?? 0),
      context: Number(m.limit?.context ?? 0),
      enabled: m.enabled !== false,
    }));
}

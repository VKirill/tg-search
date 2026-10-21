// Which OpenCode model does what. The owner picks the main chat model and ticks helper models in Settings; the app
// routes each job by what it needs (tools, vision) and how hard it is, and sets the reasoning level (variant).
import type { ModelRef } from './session';

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
  fast: ['low', 'minimal', 'medium'],
  vision: ['medium', 'low'],
  smart: ['high', 'xhigh', 'medium'],
};

function variantFor(m: CatalogModel, role: ModelRole): string | undefined {
  return EFFORT[role].find((v) => m.variants.includes(v));
}

export function pickModel(
  catalog: CatalogModel[],
  choice: { main: string; helpers: string[] },
  role: ModelRole,
  need: { tools?: boolean; vision?: boolean } = {},
): ModelRef {
  const byRef = new Map(catalog.map((m) => [refString(m), m]));
  const main = byRef.get(choice.main);
  const pool = [main, ...choice.helpers.map((r) => byRef.get(r))].filter((m): m is CatalogModel => !!m && m.enabled);
  const fits = pool.filter((m) => (!need.tools || m.tools) && (!(need.vision || role === 'vision') || m.vision));
  if (!fits.length) {
    if (main && (!need.vision || main.vision)) return { providerID: main.providerID, id: main.id, variant: variantFor(main, role) };
    throw new Error(need.vision || role === 'vision'
      ? 'Нет модели со зрением: отметьте в настройках ИИ хотя бы одну модель, которая видит картинки'
      : 'Не выбрана основная модель ИИ — выберите её в настройках');
  }
  const price = (m: CatalogModel) => m.costIn + m.costOut * 3;
  let chosen: CatalogModel;
  if (role === 'chat') chosen = fits.includes(main!) ? main! : fits[0];
  else if (role === 'smart') chosen = [...fits].sort((a, b) => price(b) - price(a))[0]; // the strongest is usually the priciest
  else chosen = [...fits].sort((a, b) => price(a) - price(b))[0]; // fast and vision: the cheapest that fits
  return { providerID: chosen.providerID, id: chosen.id, variant: variantFor(chosen, role) };
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

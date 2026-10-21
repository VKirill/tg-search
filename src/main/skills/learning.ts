import type { Db } from '../db';
import type { Order, Settings, SkillDef } from '../../shared/types';
import { clusterBriefsAsync, briefSimilarity } from './similarity';
import { clusterKey, type SkillsState } from './schema';
import { parseSkillMd, serializeSkillMd } from './frontmatter';
import { skillCoversTask, type SkillOption } from './jev';
import type { postSystemOne } from '../ai/jev';

const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
const MIN_CLUSTER = 3;
const SIM_THRESHOLD = 0.5;

export type FetchFn = typeof fetch;

export interface LearnDeps {
  db: Db;
  getSettings: () => Settings;
  dataDir: string;
  readState: () => SkillsState;
  writeState: (s: SkillsState) => void;
  saveDraftFile: (raw: string) => SkillDef;
  listActiveSkills: () => SkillOption[];
  embedBrief?: (text: string) => Promise<Float32Array | null>;
  postJev?: typeof postSystemOne;
  fetchAux?: FetchFn;
}

function doneOrdersLast60Days(db: Db): Order[] {
  const cutoff = Date.now() - SIXTY_DAYS_MS;
  return db
    .listOrders()
    .filter((o) => o.status === 'done' && o.updatedAt >= cutoff);
}

async function generateSkillDraft(
  settings: Settings,
  serviceName: string,
  priceMin: number,
  priceMax: number,
  orders: Order[],
  db: Db,
  fetchFn: FetchFn,
): Promise<string | null> {
  const base = settings.auxBaseUrl.replace(/\/$/, '');
  const key = settings.auxApiKey.trim();
  if (!base || !key || !settings.auxModel.trim()) return null;

  const blocks: string[] = [];
  for (const o of orders) {
    const msgs = db.listMessages(o.leadId).slice(-30);
    const dialog = msgs.map((m) => `${m.direction === 'in' ? 'Клиент' : 'Мы'}: ${m.text}`).join('\n');
    blocks.push(
      `### Заказ #${o.id}\nБриф: ${o.brief}\nРезультат: ${o.result ?? '—'}\nПереписка (последние сообщения):\n${dialog}`,
    );
  }

  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.auxModel,
      stream: false,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            'Ты пишешь файл SKILL.md для агента-менеджера (формат opencode / Claude Code). Ответ — только полный текст файла, ' +
            'начинается с YAML front matter (---): обязательные поля name (латиница, дефисы), description (когда использовать, ≤1024 символов), ' +
            'metadata.status: draft, metadata.source: learned. Тело на русском: когда использовать, что спросить у клиента, как оценить цену ' +
            `внутри вилки ${priceMin}–${priceMax} ₽, пошаговые действия, чеклист качества, формат сдачи. Имя умения — короткое, по смыслу задачи.`,
        },
        {
          role: 'user',
          content: `Услуга: ${serviceName}\n\nПримеры выполненных заказов:\n\n${blocks.join('\n\n')}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content?.trim() ?? null;
}

export async function maybeLearnSkillFromOrders(deps: LearnDeps): Promise<SkillDef | null> {
  const orders = doneOrdersLast60Days(deps.db);
  if (orders.length < MIN_CLUSTER) return null;

  const byService = new Map<number, Order[]>();
  for (const o of orders) {
    const list = byService.get(o.serviceId) ?? [];
    list.push(o);
    byService.set(o.serviceId, list);
  }

  const postJev = deps.postJev;
  const active = deps.listActiveSkills();

  for (const [serviceId, group] of byService) {
    if (group.length < MIN_CLUSTER) continue;
    const service = deps.db.listServices().find((s) => s.id === serviceId);
    const briefs = group.map((o) => ({ id: o.id, text: o.brief || o.result || '' }));
    const sim = (a: string, b: string) =>
      briefSimilarity(a, b, deps.embedBrief ? (t) => deps.embedBrief!(t) : undefined);
    const clusters = await clusterBriefsAsync(briefs, SIM_THRESHOLD, sim);

    for (const cluster of clusters) {
      if (cluster.length < MIN_CLUSTER) continue;
      const orderIds = cluster.map((i) => briefs[i].id).sort((a, b) => a - b);
      const key = clusterKey(serviceId, orderIds.slice(0, MIN_CLUSTER));
      const state = deps.readState();
      if (state.learnedClusters.includes(key)) continue;

      const sampleBrief = cluster.map((i) => briefs[i].text).join('\n');
      let covered = false;
      if (active.length && postJev) {
        for (const sk of active.slice(0, 5)) {
          if (await skillCoversTask(deps.getSettings, sk, sampleBrief, postJev)) {
            covered = true;
            break;
          }
        }
      }
      if (covered) continue;

      const clusterOrders = orderIds.map((id) => group.find((o) => o.id === id)!);
      const raw = await generateSkillDraft(
        deps.getSettings(),
        service?.name ?? 'Услуга',
        service?.priceMin ?? 300,
        service?.priceMax ?? 3000,
        clusterOrders,
        deps.db,
        deps.fetchAux ?? fetch,
      );
      if (!raw) continue;

      let parsed: Omit<SkillDef, 'uses' | 'updatedAt'>;
      try {
        parsed = parseSkillMd(raw);
        parsed = { ...parsed, status: 'draft', source: 'learned' };
      } catch {
        continue;
      }

      const saved = deps.saveDraftFile(serializeSkillMd(parsed));
      state.learnedClusters.push(key);
      deps.writeState(state);
      return saved;
    }
  }
  return null;
}

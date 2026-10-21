import type { Db } from '../db';
import type { Order, Settings, SkillDef } from '../../shared/types';
import { clusterBriefsAsync, briefSimilarity, jaccard } from './similarity';
import { clusterKey, type SkillsState } from './schema';
import { parseSkillMd, serializeSkillMd } from './frontmatter';
import { skillCoversTask, type SkillOption } from './jev';
import { auxEndpoint } from '../ai/gateway';
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
  const ep = auxEndpoint(settings, fetchFn, 'smart');
  if (!ep) return null;
  const { base, key } = ep;
  fetchFn = ep.fetchFn;

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
            `внутри вилки ${priceMin}–${priceMax} ₽, пошаговые действия, чеклист качества, формат сдачи и раздел «Что предложить дальше» (1–3 сопутствующие услуги, которые клиенту понадобятся после этой задачи). Имя умения — короткое, по смыслу задачи.`,
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

      let parsed: Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'>;
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

const MAX_LESSONS = 12;

// After a finished order: what to do differently next time with this skill (revisions, client remarks).
// 0–2 short lessons per skill the agent used for the lead; repeats of known lessons are dropped.
export async function learnLessonsFromOrder(deps: {
  db: Db;
  getSettings: () => Settings;
  order: Order;
  readState: () => SkillsState;
  writeState: (s: SkillsState) => void;
  skillBody: (name: string) => string | null;
  fetchAux?: FetchFn;
}): Promise<number> {
  const names = deps.readState().leadSkills[deps.order.leadId] ?? [];
  if (!names.length) return 0;
  const settings = deps.getSettings();
  const ep = auxEndpoint(settings, deps.fetchAux ?? fetch, 'fast');
  if (!ep) return 0;
  const { base, key, fetchFn } = ep;
  const dialog = deps.db.listMessages(deps.order.leadId).slice(-30)
    .map((m) => `${m.direction === 'in' ? 'Клиент' : 'Мы'}: ${m.text}`).join('\n');
  let added = 0;
  for (const name of names.slice(0, 2)) {
    const body = deps.skillBody(name);
    if (!body) continue;
    const known = deps.readState().lessons[name] ?? [];
    const res = await fetchFn(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.auxModel,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content:
              'Ты улучшаешь инструкцию агента-менеджера по итогам выполненного заказа. Найди, что стоит делать иначе в следующий ' +
              'раз: что клиент просил переделать, чем был недоволен или что похвалил, какой вопрос стоило задать сразу, что ещё он ' +
              'докупил. Ответ — только JSON {"lessons":["…"]}: 0–2 урока, каждый одно короткое правило на русском в повелительном ' +
              'наклонении, применимое к будущим заказам, без имён и деталей этого клиента. Если учиться нечему — пустой список. ' +
              'Не повторяй то, что уже есть в инструкции и в известных уроках.',
          },
          {
            role: 'user',
            content: `Инструкция «${name}»:\n${body.slice(0, 3000)}\n\nИзвестные уроки:\n${known.map((l) => `- ${l.text}`).join('\n') || '—'}\n\n` +
              `Заказ: ${deps.order.brief}\nРезультат: ${(deps.order.result ?? '—').slice(0, 1500)}\nПравок: ${deps.order.revisionsUsed}\n\nПереписка:\n${dialog}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '';
    let lessons: string[] = [];
    try {
      const m = /\{[\s\S]*\}/.exec(raw);
      lessons = ((m ? JSON.parse(m[0]) : {}) as { lessons?: unknown }).lessons as string[] ?? [];
    } catch {
      continue;
    }
    const fresh = lessons.map((l) => String(l).trim()).filter((l) => l.length > 5)
      .filter((l) => !known.some((k) => jaccard(k.text, l) >= 0.6)).slice(0, 2);
    if (!fresh.length) continue;
    const state = deps.readState();
    state.lessons[name] = [...(state.lessons[name] ?? []), ...fresh.map((text) => ({ text, at: Date.now(), orderId: deps.order.id }))]
      .slice(-MAX_LESSONS);
    deps.writeState(state);
    added += fresh.length;
  }
  return added;
}

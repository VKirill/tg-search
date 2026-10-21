// Upsell: what else this client is likely to need. Natural pairs of our services plus what other clients actually
// bought after the same service; one offer at a good moment, never repeated for a month after it was made.
import type { Service, ServiceKind } from '../../shared/types';
import type { Db } from '../db';

const REOFFER_AFTER_MS = 30 * 86400_000;
const MAX_SUGGESTIONS = 2;

// What naturally follows each kind of work, and why the client wins from it
const NEXT: Partial<Record<ServiceKind, { kind: ServiceKind; why: string }[]>> = {
  copywriting: [
    { kind: 'image_gen', why: 'обложки и картинки к постам из плана — чтобы публиковать сразу, без поиска дизайнера' },
    { kind: 'copywriting', why: 'готовые тексты постов по плану на неделю — пакетом выходит дешевле, чем по одному' },
  ],
  marketplace_card: [
    { kind: 'image_gen', why: 'инфографика и фото товара для карточки — от них зависит конверсия в выдаче' },
    { kind: 'marketplace_card', why: 'карточки для остальных товаров в том же стиле — пакетом дешевле' },
    { kind: 'copywriting', why: 'SEO-описания и ответы на отзывы' },
  ],
  image_gen: [
    { kind: 'copywriting', why: 'тексты к картинкам: посты или описания' },
    { kind: 'marketplace_card', why: 'если картинки для товара — собрать из них карточку маркетплейса' },
  ],
  homework: [{ kind: 'homework', why: 'остальные задачи из того же задания или следующей темы — сразу, пока под рукой' }],
  assistant: [{ kind: 'copywriting', why: 'оформить найденное в текст, пост или коммерческое предложение' }],
};

export interface Addon {
  service: Service;
  why: string;
}

export function recordAddonOffer(db: Db, leadId: number, serviceId: number) {
  ensureUpsellSchema(db);
  db.raw.prepare('INSERT INTO upsell_offers(lead_id, service_id, created_at) VALUES(?, ?, ?)').run(leadId, serviceId, Date.now());
}

export function ensureUpsellSchema(db: Db) {
  db.raw.exec(`CREATE TABLE IF NOT EXISTS upsell_offers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    service_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS upsell_offers_lead ON upsell_offers(lead_id, created_at);`);
}

// Other clients' next orders after a service: «after A they bought B» counts
function boughtNext(db: Db): Map<number, Map<number, number>> {
  const orders = db.listOrders().filter((o) => o.status !== 'cancelled').sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
  const byLead = new Map<number, number[]>();
  for (const o of orders) byLead.set(o.leadId, [...(byLead.get(o.leadId) ?? []), o.serviceId]);
  const next = new Map<number, Map<number, number>>();
  for (const seq of byLead.values()) {
    for (let i = 0; i + 1 < seq.length; i++) {
      const m = next.get(seq[i]) ?? new Map<number, number>();
      m.set(seq[i + 1], (m.get(seq[i + 1]) ?? 0) + 1);
      next.set(seq[i], m);
    }
  }
  return next;
}

export function suggestAddons(db: Db, leadId: number, now = Date.now()): Addon[] {
  ensureUpsellSchema(db);
  const orders = db.listOrders(leadId).filter((o) => o.status !== 'cancelled');
  if (orders.length === 0) return []; // first find out what the client wants; upsell follows a deal
  const current = orders.sort((a, b) => b.createdAt - a.createdAt)[0];
  const services = db.listServices().filter((s) => s.enabled);
  const base = services.find((s) => s.id === current.serviceId);
  if (!base) return [];
  const offered = new Set(
    (db.raw.prepare('SELECT service_id FROM upsell_offers WHERE lead_id = ? AND created_at >= ?')
      .all(leadId, now - REOFFER_AFTER_MS) as { service_id: number }[]).map((r) => r.service_id),
  );
  const ordered = new Set(orders.filter((o) => o.id !== current.id).map((o) => o.serviceId));
  const scores = new Map<number, { score: number; why: string }>();
  for (const [i, n] of (NEXT[base.kind] ?? []).entries()) {
    for (const s of services.filter((x) => x.kind === n.kind)) {
      if (!scores.has(s.id)) scores.set(s.id, { score: 10 - i, why: n.why });
    }
  }
  for (const [serviceId, count] of boughtNext(db).get(base.id) ?? []) {
    const s = services.find((x) => x.id === serviceId);
    if (!s) continue;
    const prev = scores.get(serviceId);
    scores.set(serviceId, { score: (prev?.score ?? 0) + count * 3, why: prev?.why ?? `клиенты после «${base.name}» часто заказывают и это` });
  }
  return [...scores.entries()]
    .filter(([id]) => !offered.has(id) && (id === base.id || !ordered.has(id)))
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, MAX_SUGGESTIONS)
    .map(([id, v]) => ({ service: services.find((s) => s.id === id)!, why: v.why }));
}

export function upsellBlock(db: Db, leadId: number): string {
  const addons = suggestAddons(db, leadId);
  if (!addons.length) return '';
  const lines = addons.map((a) => `- service ${a.service.id} «${a.service.name}» (${a.service.priceMin}–${a.service.priceMax} ₽): ${a.why}`);
  return `<upsell>
Ты отвечаешь и за средний чек: что ещё нужно этому клиенту.
${lines.join('\n')}
Предложи одно из этого в удачный момент — когда клиент согласился на цену или получил результат и доволен. Одной-двумя фразами, как выгоду для него (сразу, пакетом, дешевле вместе), с ценой из вилки. Перед этим вызови offer_addon. Отказ — не повторяй. Не допродавай, если клиент недоволен, торопится или ещё не решил с основной задачей.
</upsell>`;
}

// «Статистика»: messages analyzed, requests vs chatter, leads, sends and AI spend per day, plus the demand map.

import type { CategoryStat, StatsDay, StatsReport, UsageKind } from '../../shared/types';
import type { Db } from '../db';
import { todayLocal } from './limiter';

const PERIOD_DAYS = { day: 1, week: 7, month: 30 } as const;
const KINDS: UsageKind[] = ['jev', 'llm', 'stt', 'tts', 'image'];

export function buildReport(db: Db, period: StatsReport['period'], now = Date.now()): StatsReport {
  const n = PERIOD_DAYS[period];
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (n - 1));
  const days = Array.from({ length: n }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return todayLocal(d.getTime());
  });
  const threshold = Number(db.getSettings().requestThreshold || 0);
  const rows = db.statsRows(days[0], days[n - 1], threshold, start.getTime(), now);

  const byDay = new Map<string, StatsDay>(
    days.map((day) => [day, { day, analyzed: 0, requests: 0, chatter: 0, leads: 0, sent: 0, costUsd: 0, costByKind: { jev: 0, llm: 0, stt: 0, tts: 0, image: 0 } }]),
  );
  for (const r of rows.analyzed) {
    const d = byDay.get(r.day);
    if (d) Object.assign(d, { analyzed: r.n, requests: r.req ?? 0, chatter: r.n - (r.req ?? 0) });
  }
  for (const r of rows.usageByDay) {
    const d = byDay.get(r.day);
    if (!d) continue;
    d.costByKind[r.kind as UsageKind] += r.cost;
    d.costUsd += r.cost;
  }
  for (const r of rows.leads) byDay.get(todayLocal(r.ts))!.leads++;
  for (const r of rows.sent) byDay.get(todayLocal(r.ts))!.sent++;

  const list = [...byDay.values()];
  const totals = list.reduce(
    (t, d) => {
      t.analyzed += d.analyzed;
      t.requests += d.requests;
      t.chatter += d.chatter;
      t.leads += d.leads;
      t.sent += d.sent;
      t.costUsd += d.costUsd;
      for (const k of KINDS) t.costByKind[k] += d.costByKind[k];
      return t;
    },
    { analyzed: 0, requests: 0, chatter: 0, leads: 0, sent: 0, costUsd: 0, costByKind: { jev: 0, llm: 0, stt: 0, tts: 0, image: 0 } as Record<UsageKind, number> },
  );

  const names = new Map(db.listCategories().map((c) => [c.id, c.name]));
  const categories: CategoryStat[] = rows.categories.map((r) => ({
    categoryId: r.category_id,
    name: r.category_id == null ? 'Без категории' : names.get(r.category_id) ?? 'Удалённая категория',
    messages: r.n,
    requests: r.req ?? 0,
    examples: rows.examples
      .filter((e) => e.category_id === r.category_id)
      .slice(0, 5)
      .map((e) => ({ text: e.text, link: e.link, date: e.date, prob: e.request_prob })),
  }));

  const usage = rows.usage.map((r) => ({
    kind: r.kind as UsageKind, model: r.model, calls: r.calls, inputTokens: r.input ?? 0, outputTokens: r.output ?? 0,
    units: r.units ?? 0, costUsd: r.cost ?? 0,
  }));

  return { period, days: list, totals, categories, usage };
}

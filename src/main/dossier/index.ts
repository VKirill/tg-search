// Client dossier on disk: append-only history, LLM-refreshed profile, per-order folders.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ChatMessage, ClientCard, Lead, Order, OrderStatus, Settings } from '../../shared/types';
import type { Db } from '../db';
import { recordUsage } from '../usage';

const DEBOUNCE_MS = 60_000;
const HISTORY_TAIL_LINES = 80;
const AUX_TIMEOUT_MS = 90_000;

const ORDER_STATUS_RU: Record<OrderStatus, string> = {
  collecting: 'сбор брифа',
  quoted: 'озвучена цена',
  awaiting_payment: 'ожидает оплаты',
  paid: 'оплачен',
  in_progress: 'в работе',
  delivered: 'сдан',
  revision: 'правки',
  done: 'готов',
  cancelled: 'отменён',
  failed: 'ошибка',
};

const STAGE_RU: Record<string, string> = {
  new: 'новый',
  contacted: 'контакт',
  discovery: 'выяснение',
  brief_ready: 'ТЗ готово',
  handed_over: 'передан человеку',
  proposal: 'предложение',
  won: 'выигран',
  lost: 'потерян',
};

export function asciiSlug(lead: Pick<Lead, 'authorName' | 'authorUsername'>): string {
  const basis = (lead.authorUsername || lead.authorName || 'client').replace(/^@/, '').toLowerCase();
  const ascii = basis
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return ascii || 'client';
}

export function clientDirName(leadId: number, lead: Pick<Lead, 'authorName' | 'authorUsername'>): string {
  return `${leadId}-${asciiSlug(lead)}`;
}

export function resolveClientDir(dataDir: string, leadId: number, lead: Lead): string {
  const clientsRoot = join(dataDir, 'clients');
  mkdirSync(clientsRoot, { recursive: true });
  const prefix = `${leadId}-`;
  const existing = readdirSync(clientsRoot).find((d) => d.startsWith(prefix));
  if (existing) return join(clientsRoot, existing);
  const dir = join(clientsRoot, clientDirName(leadId, lead));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function speakerLabel(message: ChatMessage): string {
  if (message.kind === 'note') return 'Заметка';
  if (message.direction === 'in') return 'Клиент';
  if (message.auto) return 'ИИ-менеджер';
  return 'Мы';
}

export function formatMessageHistoryLine(message: ChatMessage): string {
  const ts = formatTimestamp(message.date);
  const who = speakerLabel(message);
  let text = message.text.replace(/\s+/g, ' ').trim();
  if (message.kind === 'voice') {
    const dur = message.durationSec != null ? `0:${String(message.durationSec).padStart(2, '0')}` : '0:00';
    text = `🎙 голосовое ${dur} — расшифровка: ${text}`;
  } else if (message.kind === 'call') {
    const dur = message.durationSec != null ? `0:${String(message.durationSec).padStart(2, '0')}` : '0:00';
    text = `🎙 созвон ${dur} — расшифровка: ${text}`;
  }
  return `${ts} · ${who} · ${text}`;
}

export function formatOrderHistoryLine(order: Order, prev?: OrderStatus): string {
  const ts = formatTimestamp(order.updatedAt);
  const status = ORDER_STATUS_RU[order.status];
  if (prev == null) return `${ts} · Заказ #${order.id} · статус: ${status}`;
  const from = ORDER_STATUS_RU[prev];
  return `${ts} · Заказ #${order.id} · ${from} → ${status}`;
}

export function formatHandoffHistoryLine(lead: Lead): string {
  const ts = formatTimestamp(Date.now());
  if (lead.handoff) {
    const reason = lead.handoffReason?.trim() || 'передача человеку';
    return `${ts} · Передача · ${reason}`;
  }
  return `${ts} · Передача · диалог возвращён ИИ-менеджеру`;
}

function yamlScalar(v: string | null | undefined): string {
  const s = v ?? '';
  if (/[:#{}[\],&*?]|^\s|\s$/.test(s) || s.includes('\n')) return JSON.stringify(s);
  return s === '' ? '""' : s;
}

export function buildProfileFrontMatter(lead: Lead, card: ClientCard, updatedDay: string): string {
  return `---
leadId: ${lead.id}
name: ${yamlScalar(lead.authorName)}
username: ${yamlScalar(lead.authorUsername ? (lead.authorUsername.startsWith('@') ? lead.authorUsername : `@${lead.authorUsername}`) : null)}
stage: ${card.stage}
updated: ${updatedDay}
---`;
}

export function parseProfileFrontMatter(raw: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function readHistoryTail(historyPath: string, maxLines: number): string[] {
  try {
    const lines = readFileSync(historyPath, 'utf8').split('\n').filter((l) => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function appendHistoryLine(dir: string, line: string) {
  appendFileSync(join(dir, 'history.md'), line + '\n', 'utf8');
}

export function writeOrderMarkdown(order: Order, serviceName: string, clientDir: string): string {
  const orderDir = join(clientDir, 'orders', String(order.id));
  mkdirSync(orderDir, { recursive: true });
  const rel = (p: string) => basename(p);
  const byRole = (role: Order['files'][number]['role']) =>
    order.files.filter((f) => f.role === role).map((f) => `- [${f.name}](./${rel(f.path)}) (${f.mime})`).join('\n') || '—';
  const price = order.price != null ? `${order.price} ₽` : 'не названа';
  const paid = order.paidAt ? formatTimestamp(order.paidAt) : '—';
  const payment = order.paymentUrl ? `[ссылка](${order.paymentUrl})` : '—';
  const body = `# Заказ #${order.id}

**Статус:** ${ORDER_STATUS_RU[order.status]} (\`${order.status}\`)
**Услуга:** ${serviceName}
**Цена:** ${price}
**Оплата:** ${payment}
**Оплачен:** ${paid}

## Бриф

${order.brief.trim() || '—'}

## Результат

${order.result?.trim() || '—'}

## Файлы

### Входящие
${byRole('input')}

### Превью
${byRole('preview')}

### Результат
${byRole('output')}
`;
  const path = join(orderDir, 'order.md');
  writeFileSync(path, body, 'utf8');
  return path;
}

function buildProfileUserPrompt(
  lead: Lead,
  card: ClientCard,
  orders: Order[],
  services: Map<number, string>,
  historyLines: string[],
): string {
  const an = card.anamnesis;
  const ordersBlock =
    orders.length === 0
      ? 'Заказов пока нет.'
      : orders
          .map((o) => {
            const svc = services.get(o.serviceId) ?? `услуга #${o.serviceId}`;
            return `- #${o.id} ${svc}: ${ORDER_STATUS_RU[o.status]}, ${o.price ?? '—'} ₽, бриф: ${o.brief.slice(0, 200)}`;
          })
          .join('\n');
  return `Собери досье клиента на русском языке (только тело Markdown, без front matter).

## Данные лида
Имя: ${lead.authorName ?? '—'}
Username: ${lead.authorUsername ?? '—'}
Исходный запрос: ${lead.text}
Этап CRM: ${STAGE_RU[card.stage] ?? card.stage}
Саммари: ${card.summary}
Полнота анамнеза: ${card.completeness}%

## Анамнез
Задача: ${an.task}
Цель: ${an.goal}
Аудитория: ${an.audience}
Функционал: ${an.features.join(', ') || '—'}
Интеграции: ${an.integrations.join(', ') || '—'}
Стек: ${an.stack.join(', ') || '—'}
Сроки: ${an.deadline}
Бюджет: ${an.budget}
Референсы: ${an.references.join(', ') || '—'}
Контакты: ${an.contacts}
Открытые вопросы: ${an.openQuestions.join('; ') || '—'}

Заметки владельца: ${card.notes.trim() || '—'}

## Заказы
${ordersBlock}

## Последние строки истории
${historyLines.join('\n')}

Используй ровно эти заголовки второго уровня (##), по одному разделу на каждый:
## Кто клиент
## Что хочет (в его словах)
## Что мы о нём знаем (ниша, аккаунты, ссылки, конкуренты, предпочтения, тон)
## Заказы и оплаты
## Договорённости
## Что предложить дальше (upsell ideas)
## Риски/заметки

Пиши конкретно, без воды. Если данных нет — коротко «пока неизвестно».`;
}

export type AuxFetch = typeof fetch;

async function auxComplete(settings: Settings, userPrompt: string, fetchFn: AuxFetch): Promise<string> {
  const base = settings.auxBaseUrl.replace(/\/$/, '');
  const key = settings.auxApiKey.trim();
  if (!base || !key || !settings.auxModel.trim()) throw new Error('aux model not configured');
  const res = await fetchFn(`${base}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.auxModel,
      stream: false,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'Ты ведёшь досье клиента для владельца студии/агентства. Отвечай только телом Markdown на русском, без YAML front matter.',
        },
        { role: 'user', content: userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(AUX_TIMEOUT_MS),
  });
  if (!res.ok) {
    const excerpt = (await res.text()).slice(0, 200);
    throw new Error(`aux HTTP ${res.status}: ${excerpt}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  recordUsage({
    kind: 'llm',
    model: settings.auxModel,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  });
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('aux empty response');
  return content;
}

export interface DossierDeps {
  db: Db;
  dataDir: string;
  settings: () => Settings;
  fetchFn?: AuxFetch;
}

export function createDossier(deps: DossierDeps) {
  const fetchFn = deps.fetchFn ?? fetch;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const lastHandoff = new Map<number, boolean>();
  const lastOrderStatus = new Map<number, OrderStatus>();
  const refreshWork = new Map<number, Promise<void>>();

  function clearTimer(leadId: number) {
    const t = timers.get(leadId);
    if (t) clearTimeout(t);
    timers.delete(leadId);
  }

  async function refreshProfile(leadId: number): Promise<void> {
    const existing = refreshWork.get(leadId);
    if (existing) return existing;
    const work = (async () => {
      const lead = deps.db.getLead(leadId);
      const card = deps.db.getCard(leadId);
      const dir = resolveClientDir(deps.dataDir, leadId, lead);
      const profilePath = join(dir, 'profile.md');
      let previous = '';
      try {
        previous = readFileSync(profilePath, 'utf8');
      } catch {
        /* no profile yet */
      }
      const historyLines = readHistoryTail(join(dir, 'history.md'), HISTORY_TAIL_LINES);
      const orders = deps.db.listOrders(leadId);
      const services = new Map(deps.db.listServices().map((s) => [s.id, s.name]));
      const prompt = buildProfileUserPrompt(lead, card, orders, services, historyLines);
      try {
        const body = await auxComplete(deps.settings(), prompt, fetchFn);
        const day = new Date().toISOString().slice(0, 10);
        const doc = `${buildProfileFrontMatter(lead, card, day)}\n\n${body.trim()}\n`;
        writeFileSync(profilePath, doc, 'utf8');
      } catch (err) {
        console.error('dossier profile refresh', leadId, err);
        if (previous) writeFileSync(profilePath, previous, 'utf8');
      }
    })().finally(() => refreshWork.delete(leadId));
    refreshWork.set(leadId, work);
    return work;
  }

  function scheduleProfileRefresh(leadId: number) {
    clearTimer(leadId);
    const timer = setTimeout(() => {
      timers.delete(leadId);
      void refreshProfile(leadId);
    }, DEBOUNCE_MS);
    timers.set(leadId, timer);
  }

  function onMessage(message: ChatMessage) {
    const lead = deps.db.getLead(message.leadId);
    const dir = resolveClientDir(deps.dataDir, message.leadId, lead);
    appendHistoryLine(dir, formatMessageHistoryLine(message));
    scheduleProfileRefresh(message.leadId);
  }

  function onLeadUpdate(lead: Lead) {
    const prev = lastHandoff.get(lead.id);
    if (prev === undefined) {
      lastHandoff.set(lead.id, lead.handoff);
      return;
    }
    if (prev !== lead.handoff) {
      const dir = resolveClientDir(deps.dataDir, lead.id, lead);
      appendHistoryLine(dir, formatHandoffHistoryLine(lead));
      lastHandoff.set(lead.id, lead.handoff);
      scheduleProfileRefresh(lead.id);
    }
  }

  function onOrder(order: Order) {
    const lead = deps.db.getLead(order.leadId);
    const dir = resolveClientDir(deps.dataDir, order.leadId, lead);
    let serviceName = `услуга #${order.serviceId}`;
    try {
      serviceName = deps.db.getService(order.serviceId).name;
    } catch {
      /* service may be missing in tests */
    }
    writeOrderMarkdown(order, serviceName, dir);
    const prev = lastOrderStatus.get(order.id);
    if (prev !== order.status) {
      appendHistoryLine(dir, formatOrderHistoryLine(order, prev));
      lastOrderStatus.set(order.id, order.status);
    }
    scheduleProfileRefresh(order.leadId);
  }

  function path(leadId: number): string {
    const lead = deps.db.getLead(leadId);
    return resolveClientDir(deps.dataDir, leadId, lead);
  }

  function stop() {
    for (const id of timers.keys()) clearTimer(id);
  }

  return {
    onMessage,
    onLeadUpdate,
    onOrder,
    path,
    stop,
    refreshProfile,
    scheduleProfileRefresh,
    DEBOUNCE_MS,
  };
}

export type Dossier = ReturnType<typeof createDossier>;

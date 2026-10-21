import type {
  AssetRole,
  DealStage,
  FactKind,
  OrderStatus,
  ServiceKind,
  SubscriptionStatus,
} from '../../../shared/types';

const MONTHS = ['янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.', 'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.'];

export function formatLeadDate(ms: number): string {
  const d = new Date(ms);
  const day = d.getDate();
  const month = MONTHS[d.getMonth()];
  const h = d.getHours();
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${day} ${month}, ${h}:${m}`;
}

export function formatShortTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function initials(name: string | null | undefined): string {
  if (!name?.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

const AVATAR_HUES = [210, 175, 145, 265, 320, 25, 95, 55];

export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  return `hsl(${hue} 42% 38%)`;
}

export function displayName(lead: { authorName: string | null; authorUsername: string | null }): string {
  if (lead.authorName?.trim()) return lead.authorName.trim();
  if (lead.authorUsername) return `@${lead.authorUsername}`;
  return 'Неизвестный автор';
}

export function taskLabel(task: string): string {
  const map: Record<string, string> = {
    clients: 'Клиентов',
    partners: 'Партнёров',
    investors: 'Инвесторов',
    jobs: 'Вакансии',
    ads: 'Объявления',
  };
  return map[task] ?? task;
}

export function sourceKindLabel(kind: string): string {
  const map: Record<string, string> = {
    channel: 'Канал',
    supergroup: 'Супергруппа',
    group: 'Группа',
    private: 'Личный',
  };
  return map[kind] ?? kind;
}

export function leadStatusTag(status: string): string {
  const map: Record<string, string> = {
    new: 'Без ответа',
    replied: 'Отвечено',
    dialog: 'Диалог',
    hidden: 'Скрыт',
  };
  return map[status] ?? status;
}

export function leadLabelTag(label: string): string {
  const map: Record<string, string> = {
    demand: 'Спрос',
    interest: 'Интересант',
    irrelevant: 'Не релевантно',
  };
  return map[label] ?? label;
}

export function sourceStatusLabel(status: string): string {
  const map: Record<string, string> = {
    active: 'Подходит',
    candidate: 'Кандидат',
    rejected: 'Отклонён',
  };
  return map[status] ?? status;
}

export function nextRunText(nextRunAt: number | null): string {
  if (!nextRunAt) return '—';
  const d = new Date(nextRunAt);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function dealStageLabel(stage: DealStage): string {
  const map: Record<DealStage, string> = {
    new: 'Новый',
    contacted: 'Связались',
    discovery: 'Сбор требований',
    brief_ready: 'ТЗ готово',
    handed_over: 'Передан Кириллу',
    proposal: 'КП отправлено',
    won: 'В работе / Выигран',
    lost: 'Отказ',
  };
  return map[stage] ?? stage;
}

export const DEAL_STAGES: DealStage[] = [
  'new',
  'contacted',
  'discovery',
  'brief_ready',
  'handed_over',
  'proposal',
  'won',
  'lost',
];

export function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function foundByLabel(foundBy: string | null): string {
  if (!foundBy) return '—';
  if (foundBy === 'manual') return 'вручную';
  if (foundBy === 'member') return 'участник';
  if (foundBy === 'csv') return 'CSV';
  return 'поиск';
}

export function orderStatusLabel(status: OrderStatus): string {
  const map: Record<OrderStatus, string> = {
    collecting: 'Сбор хотелок',
    quoted: 'Цена названа',
    awaiting_payment: 'Ждёт оплаты',
    paid: 'Оплачен',
    in_progress: 'В работе',
    delivered: 'Сдан',
    revision: 'Правки',
    done: 'Готово',
    cancelled: 'Отменён',
    failed: 'Ошибка',
  };
  return map[status] ?? status;
}

export function serviceKindLabel(kind: ServiceKind): string {
  const map: Record<ServiceKind, string> = {
    homework: 'Домашка',
    marketplace_card: 'Карточка МП',
    image_gen: 'Нейрофото',
    copywriting: 'Тексты',
    assistant: 'Ассистент',
    agent: 'Агент',
  };
  return map[kind] ?? kind;
}

export function formatRub(n: number): string {
  return `${n.toLocaleString('ru-RU')} ₽`;
}

export function formatPriceRange(min: number, max: number): string {
  return `${min.toLocaleString('ru-RU')}–${max.toLocaleString('ru-RU')} ₽`;
}

export function factKindLabel(kind: FactKind): string {
  const map: Record<FactKind, string> = {
    profile: 'Профиль',
    preference: 'Предпочтения',
    deal: 'Договорённости',
    material: 'Материалы',
    other: 'Прочее',
  };
  return map[kind];
}

export const FACT_KINDS: FactKind[] = ['profile', 'preference', 'deal', 'material', 'other'];

export function assetRoleLabel(role: AssetRole): string {
  const map: Record<AssetRole, string> = {
    from_client: 'От клиента',
    preview: 'Превью',
    delivered: 'Сдано',
    working: 'Рабочие',
  };
  return map[role];
}

export function subscriptionStatusLabel(status: SubscriptionStatus): string {
  const map: Record<SubscriptionStatus, string> = {
    pending: 'Ожидает оплаты',
    active: 'Активна',
    past_due: 'Просрочена',
    canceled: 'Отменена',
  };
  return map[status];
}

export function paymentStatusLabel(status: 'pending' | 'succeeded' | 'canceled'): string {
  const map: Record<'pending' | 'succeeded' | 'canceled', string> = {
    pending: 'Ждёт оплаты',
    succeeded: 'Оплачен',
    canceled: 'Отменён',
  };
  return map[status];
}

export function formatDateShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function formatEpisodePeriod(fromMs: number, toMs: number): string {
  const a = new Date(fromMs);
  const b = new Date(toMs);
  const sameYear = a.getFullYear() === b.getFullYear();
  const left = `${a.getDate()} ${MONTHS[a.getMonth()]}${sameYear ? '' : ` ${a.getFullYear()}`}`;
  const right = `${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  return `${left} — ${right}`;
}

export function daysRemaining(periodEnd: number | null): number | null {
  if (periodEnd == null) return null;
  return Math.max(0, Math.ceil((periodEnd - Date.now()) / 86_400_000));
}

export function agentToolLabel(tool: string): string {
  const map: Record<string, string> = {
    reply: 'Ответ клиенту',
    search_memory: 'Поиск в памяти',
    remember: 'Запомнил',
    create_order: 'Заказ',
    preview: 'Превью',
    request_payment: 'Оплата',
    payment_status: 'Оплата',
    subscription: 'Подписка',
    run_task: 'Поручение',
    web_search: 'Поиск в интернете',
    fetch_url: 'Чтение страницы',
    send_asset: 'Отправка файла',
    handoff: 'Передача человеку',
  };
  return map[tool] ?? tool;
}

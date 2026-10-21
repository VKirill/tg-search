import type { ChatMessage, ClientCard, Lead, Project } from '../../shared/types';
import type { Db } from '../db';
import { managerServicesContext } from '../ai/manager';
import type { MemoryStore } from '../memory/types';

export function fallbackClientContext(db: Db, leadId: number, card?: ClientCard): string {
  const messages = db.listMessages(leadId).slice(-30);
  const lines = messages.map((m) => `${m.direction === 'in' ? 'Клиент' : 'Мы'}: ${m.text}`);
  const cardBlock = card
    ? `Карточка: полнота ${card.completeness}%, задача: ${card.anamnesis.task || '—'}`
    : '';
  return `Последние сообщения:\n${lines.join('\n') || '(пусто)'}\n${cardBlock}`;
}

export function buildClientContext(
  db: Db,
  lead: Lead,
  lastClientText: string,
  memory?: MemoryStore,
  card?: ClientCard,
): string {
  if (memory) {
    const ctx = memory.context(lead.id, lastClientText);
    if (ctx.text.trim()) return ctx.text;
  }
  return fallbackClientContext(db, lead.id, card);
}

export function catalogContext(db: Db, leadId: number, billingPlans?: string): string {
  const services = managerServicesContext(db.listServices(), db.listOrders(leadId));
  const plans = billingPlans ? `\n\nТарифы подписки:\n${billingPlans}` : '';
  return `${services}${plans}`;
}

export function projectManagerPrompt(project: Project, mgrPrompt: string, owner: string): string {
  const materials = project.materials.map((m) => m.text?.trim()).filter(Boolean).join('\n\n') || '—';
  return `${mgrPrompt}

Контекст проекта «${project.name}»:
Задача: ${project.task}
Кого ищем: ${project.target}
Оффер: ${project.offer}
Критерии: ${project.criteria || '—'}
Материалы:
${materials}`.replaceAll('{owner}', owner || 'владельца');
}

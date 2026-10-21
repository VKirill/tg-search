import type { Db } from '../db';

export function buildApprovalSummary(db: Db, tool: string, args: Record<string, unknown>): string {
  if (tool === 'request_payment') {
    const orderId = Number(args.orderId);
    if (Number.isFinite(orderId)) {
      try {
        const order = db.getOrder(orderId);
        const service = db.getService(order.serviceId);
        const amount = order.price ?? service.priceMin;
        return `Выставить счёт ${amount} ₽ за ${service.name}`;
      } catch {
        // fall through
      }
    }
  }
  if (tool === 'offer_subscription') {
    const planId = Number(args.planId);
    if (Number.isFinite(planId)) {
      try {
        const plans = db.raw.prepare('SELECT name, price_month FROM plans WHERE id = ?').get(planId) as
          | { name: string; price_month: number }
          | undefined;
        if (plans) return `Оформить подписку «${plans.name}» (${plans.price_month} ₽/мес)`;
      } catch {
        // billing schema may be absent in unit tests
      }
      return `Оформить подписку (тариф #${planId})`;
    }
  }
  if (tool === 'delegate') {
    const agent = String(args.agent ?? '');
    const task = String(args.task ?? '').slice(0, 80);
    return `Делегировать агенту «${agent}»: ${task}`;
  }
  return `Выполнить ${tool}`;
}

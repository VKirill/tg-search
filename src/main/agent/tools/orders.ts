import type { ManagerOrderIntent } from '../../../shared/types';
import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';

function priceInRange(min: number, max: number, price: number): boolean {
  return price >= min && price <= max;
}

export function createOrderTools(deps: ToolHostDeps): AgentTool[] {
  const createOrUpdate: AgentTool = {
    name: 'create_or_update_order',
    description: 'Создать или обновить заказ по услуге из каталога; цена только внутри вилки услуги.',
    parameters: {
      type: 'object',
      properties: {
        serviceId: { type: 'number' },
        brief: { type: 'string' },
        price: { type: 'number', description: 'Согласованная цена в ₽' },
      },
      required: ['serviceId', 'brief'],
    },
    async run(args, ctx) {
      const serviceId = Number(args.serviceId);
      const brief = String(args.brief ?? '').trim();
      if (!Number.isFinite(serviceId)) return 'Ошибка: serviceId';
      let service;
      try {
        service = deps.db.getService(serviceId);
      } catch {
        return 'Ошибка: услуга не найдена';
      }
      if (!service.enabled) return 'Ошибка: услуга недоступна';
      const price = args.price != null ? Number(args.price) : null;
      if (price != null && !priceInRange(service.priceMin, service.priceMax, price)) {
        return `Ошибка: цена вне вилки ${service.priceMin}–${service.priceMax} ₽`;
      }
      const intent: ManagerOrderIntent = {
        serviceId,
        brief,
        agreedPrice: price,
        wantsPreview: false,
        readyToPay: false,
        photoConsent: false,
      };
      deps.turnState.orderIntent = intent;
      if (ctx.dryRun) {
        return `[dryRun] Заказ по услуге #${serviceId}, цена ${price ?? '—'}`;
      }
      if (!deps.orders) return 'Ошибка: заказы не подключены';
      try {
        await deps.orders.applyManagerIntent(ctx.leadId, intent);
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
      const open = deps.db.listOrders(ctx.leadId).find((o) => o.serviceId === serviceId);
      return open ? `Заказ #${open.id}, статус ${open.status}` : 'Заказ обновлён';
    },
  };

  const preview: AgentTool = {
    name: 'preview',
    description: 'Сделать бесплатное превью по заказу (если услуга поддерживает).',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'number' } },
      required: ['orderId'],
    },
    async run(args, ctx) {
      const orderId = Number(args.orderId);
      if (ctx.dryRun) return `[dryRun] Превью для заказа #${orderId}`;
      let order;
      try {
        order = deps.db.getOrder(orderId);
      } catch {
        return 'Заказ не найден';
      }
      if (order.leadId !== ctx.leadId) return 'Заказ принадлежит другому лиду';
      const service = deps.db.getService(order.serviceId);
      if (!service.previewEnabled) return 'Превью для этой услуги недоступно';
      const intent: ManagerOrderIntent = {
        serviceId: order.serviceId,
        brief: order.brief,
        agreedPrice: order.price,
        wantsPreview: true,
        readyToPay: false,
        photoConsent: false,
      };
      if (!deps.orders) return 'Заказы не подключены';
      try {
        await deps.orders.applyManagerIntent(ctx.leadId, intent);
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
      return 'Превью отправлено';
    },
  };

  const requestPayment: AgentTool = {
    name: 'request_payment',
    description: 'Выставить счёт на оплату заказа (ссылка ЮKassa клиенту).',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'number' } },
      required: ['orderId'],
    },
    async run(args, ctx) {
      const orderId = Number(args.orderId);
      if (ctx.dryRun) return `[dryRun] Счёт на заказ #${orderId}`;
      let order;
      try {
        order = deps.db.getOrder(orderId);
      } catch {
        return 'Заказ не найден';
      }
      if (order.leadId !== ctx.leadId) return 'Заказ принадлежит другому лиду';
      if (!deps.orders) return 'Заказы не подключены';
      try {
        const updated = await deps.orders.requestPayment(orderId);
        return `Ссылка на оплату отправлена, статус ${updated.status}`;
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  const orderStatus: AgentTool = {
    name: 'order_status',
    description: 'Статус заказа и краткие детали.',
    parameters: {
      type: 'object',
      properties: { orderId: { type: 'number' } },
      required: ['orderId'],
    },
    async run(args, ctx) {
      const orderId = Number(args.orderId);
      try {
        const order = deps.db.getOrder(orderId);
        if (order.leadId !== ctx.leadId) return 'Заказ другого лида';
        const service = deps.db.getService(order.serviceId);
        return `#${order.id} ${service.name}: статус ${order.status}, цена ${order.price ?? '—'} ₽, бриф: ${order.brief.slice(0, 300)}`;
      } catch {
        return 'Заказ не найден';
      }
    },
  };

  return [createOrUpdate, preview, requestPayment, orderStatus];
}

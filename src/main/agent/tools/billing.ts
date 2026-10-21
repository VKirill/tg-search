import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';

export function createBillingTools(deps: ToolHostDeps): AgentTool[] {
  const billingStatus: AgentTool = {
    name: 'billing_status',
    description: 'Подписка клиента, остаток дней и поручений, неоплаченные счета.',
    parameters: { type: 'object', properties: {} },
    async run(_args, ctx) {
      if (!deps.billing) return 'Биллинг не подключён';
      if (ctx.clientId == null) return 'Клиент не привязан';
      const st = deps.billing.status(ctx.clientId);
      const sub = st.subscription
        ? `Подписка: ${st.plan?.name ?? '—'}, статус ${st.subscription.status}, дней ${st.daysLeft ?? '—'}, поручений ${st.tasksLeft ?? '—'}`
        : 'Подписки нет';
      const unpaid =
        st.unpaid.length
          ? st.unpaid.map((p) => `#${p.id} ${p.amount} ₽ ${p.status}`).join('; ')
          : 'нет';
      return `${sub}\nНеоплаченные: ${unpaid}`;
    },
  };

  const offerSubscription: AgentTool = {
    name: 'offer_subscription',
    description: 'Оформить подписку и отправить счёт на первый период.',
    parameters: {
      type: 'object',
      properties: { planId: { type: 'number' } },
      required: ['planId'],
    },
    async run(args, ctx) {
      if (!deps.billing) return 'Биллинг не подключён';
      if (ctx.clientId == null) return 'Клиент не привязан';
      const planId = Number(args.planId);
      if (ctx.dryRun) return `[dryRun] Подписка plan #${planId}`;
      try {
        const sub = await deps.billing.subscribe(ctx.clientId, planId);
        return `Подписка #${sub.id}, статус ${sub.status}`;
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  const checkPayment: AgentTool = {
    name: 'check_payment',
    description: 'Проверить статус платежа у провайдера.',
    parameters: {
      type: 'object',
      properties: { paymentId: { type: 'number' } },
      required: ['paymentId'],
    },
    async run(args, ctx) {
      if (!deps.billing) return 'Биллинг не подключён';
      const paymentId = Number(args.paymentId);
      if (ctx.dryRun) return `[dryRun] Проверка платежа #${paymentId}`;
      try {
        const p = await deps.billing.check(paymentId);
        if (p.clientId !== ctx.clientId) return 'Платёж другого клиента';
        return `Платёж #${p.id}: ${p.status}, ${p.amount} ₽`;
      } catch (e) {
        return `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  };

  return [billingStatus, offerSubscription, checkPayment];
}

import { useCallback, useEffect, useState } from 'react';
import type { Payment, Plan, Subscription } from '../../../../shared/types';
import {
  daysRemaining,
  formatDateShort,
  formatRub,
  paymentStatusLabel,
  subscriptionStatusLabel,
} from '../../utils/format';
import { getApi } from '../../hooks/useApi';

type CrmMoneyTabProps = {
  clientId: number;
  toast: (msg: string) => void;
};

export function CrmMoneyTab({ clientId, toast }: CrmMoneyTabProps) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [pickPlanId, setPickPlanId] = useState<number | ''>('');

  const load = useCallback(async () => {
    try {
      const [p, s, pay] = await Promise.all([
        getApi().billing.plans(),
        getApi().billing.subscriptions(clientId),
        getApi().billing.payments(clientId),
      ]);
      setPlans(p.filter((x) => x.enabled));
      setSubs(s);
      setPayments(pay);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [clientId, toast]);

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'billing:update' && e.clientId === clientId) load();
    });
    return off;
  }, [clientId, load]);

  const active = subs.find((s) => s.status !== 'canceled') ?? subs[0] ?? null;
  const plan = active ? plans.find((p) => p.id === active.planId) : null;

  const subscribe = async () => {
    if (pickPlanId === '') {
      toast('Выберите тариф');
      return;
    }
    try {
      await getApi().billing.subscribe(clientId, pickPlanId);
      toast('Счёт на подписку отправлен клиенту');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const cancel = async () => {
    if (!active) return;
    if (!confirm('Отменить подписку? Текущий период не продлится.')) return;
    try {
      await getApi().billing.cancelSubscription(active.id);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const checkPayment = async (id: number) => {
    try {
      await getApi().billing.checkPayment(id);
      toast('Статус обновлён');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const left = active?.periodEnd != null ? daysRemaining(active.periodEnd) : null;

  return (
    <div className="crm-tab crm-tab--money">
      <section className="crm-subsection">
        <h3>Подписка</h3>
        {!active && (
          <p className="crm-muted">Активной подписки нет. Оформите тариф «личный ассистент» — агент выставит счёт.</p>
        )}
        {active && (
          <div className="sub-card">
            <div className="sub-card__head">
              <span className="sub-card__plan">{plan?.name ?? `Тариф #${active.planId}`}</span>
              <span className={`sub-chip sub-chip--${active.status}`}>{subscriptionStatusLabel(active.status)}</span>
            </div>
            {plan && <p className="sub-card__desc">{plan.description}</p>}
            {active.periodStart != null && active.periodEnd != null && (
              <p className="crm-muted">
                Период: {formatDateShort(active.periodStart)} — {formatDateShort(active.periodEnd)}
                {left != null && active.status === 'active' && ` · осталось ${left} дн.`}
              </p>
            )}
            {plan && (
              <p className="sub-card__quota">
                Поручений: {active.tasksUsed} из {plan.tasksPerMonth}
              </p>
            )}
            {active.status !== 'canceled' && (
              <button type="button" className="btn btn--sm btn--ghost" onClick={cancel}>Отменить</button>
            )}
          </div>
        )}
        <div className="sub-subscribe">
          <select value={pickPlanId} onChange={(e) => setPickPlanId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Тариф…</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatRub(p.priceMonth)}/мес · {p.tasksPerMonth} поруч.
              </option>
            ))}
          </select>
          <button type="button" className="btn btn--sm btn--primary" onClick={subscribe}>Оформить подписку</button>
        </div>
      </section>
      <section className="crm-subsection">
        <h3>Платежи</h3>
        {payments.length === 0 && <p className="crm-muted">Платежей пока не было.</p>}
        <ul className="payments-ledger">
          {payments.map((p) => (
            <li key={p.id} className="payment-row">
              <div className="payment-row__date">{formatDateShort(p.createdAt)}</div>
              <div className="payment-row__purpose">
                {p.purpose === 'subscription' ? 'Подписка' : 'Заказ'}
                {p.orderId != null && ` #${p.orderId}`}
              </div>
              <div className="payment-row__amount">{formatRub(p.amount)}</div>
              <div className={`payment-row__status payment-row__status--${p.status}`}>
                {paymentStatusLabel(p.status)}
              </div>
              <div className="payment-row__actions">
                {p.url && (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => getApi().shell.openExternal(p.url!)}>
                    Ссылка
                  </button>
                )}
                {p.status === 'pending' && (
                  <button type="button" className="btn btn--sm" onClick={() => checkPayment(p.id)}>Проверить</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

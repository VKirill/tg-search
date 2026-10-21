import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Client, Payment, Plan, Subscription } from '../../../shared/types';
import {
  formatDateShort,
  formatRub,
  paymentStatusLabel,
  subscriptionStatusLabel,
} from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type PlanDraft = Omit<Plan, 'id'> & { id?: number };

type PayFilter = 'all' | 'pending' | 'succeeded' | 'canceled';

function emptyPlan(): PlanDraft {
  return {
    name: '',
    priceMonth: 1990,
    tasksPerMonth: 10,
    description: '',
    enabled: true,
  };
}

export function SubscriptionsView() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [editing, setEditing] = useState<PlanDraft | null>(null);
  const [payFilter, setPayFilter] = useState<PayFilter>('all');

  const load = useCallback(async () => {
    try {
      const [p, s, pay, c] = await Promise.all([
        getApi().billing.plans(),
        getApi().billing.subscriptions(),
        getApi().billing.payments(),
        getApi().clients.list(),
      ]);
      setPlans(p);
      setSubs(s);
      setPayments(pay);
      setClients(c);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'billing:update') load();
    });
    return off;
  }, [load]);

  const clientName = (id: number) => clients.find((c) => c.id === id)?.name ?? `Клиент #${id}`;

  const filteredPayments = useMemo(() => {
    if (payFilter === 'all') return payments;
    return payments.filter((p) => p.status === payFilter);
  }, [payments, payFilter]);

  const monthTotal = useMemo(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    return payments
      .filter((p) => p.status === 'succeeded' && p.paidAt != null && p.paidAt >= start.getTime())
      .reduce((s, p) => s + p.amount, 0);
  }, [payments]);

  const savePlan = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast('Укажите название тарифа');
      return;
    }
    try {
      await getApi().billing.savePlan(editing);
      setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const removePlan = async (id: number) => {
    if (!confirm('Удалить тариф? Активные подписки останутся с прежним planId.')) return;
    try {
      await getApi().billing.removePlan(id);
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

  return (
    <div className="page-view page-view--subscriptions">
      <div className="page-view__head">
        <h1>Подписки</h1>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => setEditing(emptyPlan())}>
          Новый тариф
        </button>
      </div>

      <section className="subs-section">
        <h2 className="section-title">Тарифы</h2>
        <div className="plan-grid">
          {plans.map((p) => (
            <article key={p.id} className={`plan-card${p.enabled ? '' : ' plan-card--off'}`}>
              <div className="plan-card__head">
                <span className="plan-card__name">{p.name}</span>
                <span className="plan-card__price">{formatRub(p.priceMonth)}/мес</span>
              </div>
              <p className="plan-card__meta">{p.tasksPerMonth} поручений в месяц</p>
              <p className="plan-card__desc">{p.description}</p>
              <div className="plan-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => setEditing({ ...p })}>Изменить</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => removePlan(p.id)}>Удалить</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="subs-section">
        <h2 className="section-title">Активные подписки</h2>
        {subs.length === 0 && <p className="crm-muted">Подписок пока нет.</p>}
        <ul className="subs-list">
          {subs.map((s) => {
            const plan = plans.find((p) => p.id === s.planId);
            return (
              <li key={s.id} className="subs-list__row">
                <span className="subs-list__client">{clientName(s.clientId)}</span>
                <span className="subs-list__plan">{plan?.name ?? `#${s.planId}`}</span>
                <span className={`sub-chip sub-chip--${s.status}`}>{subscriptionStatusLabel(s.status)}</span>
                {s.periodEnd != null && (
                  <span className="subs-list__period">до {formatDateShort(s.periodEnd)}</span>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="subs-section">
        <div className="subs-section__head">
          <h2 className="section-title">Журнал платежей</h2>
          <span className="subs-month-total">За месяц: {formatRub(monthTotal)}</span>
        </div>
        <div className="pay-filters">
          {(['all', 'pending', 'succeeded', 'canceled'] as PayFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={`chip${payFilter === f ? ' chip--active' : ''}`}
              onClick={() => setPayFilter(f)}
            >
              {f === 'all' ? 'Все' : paymentStatusLabel(f)}
            </button>
          ))}
        </div>
        <ul className="payments-ledger payments-ledger--wide">
          {filteredPayments.map((p) => (
            <li key={p.id} className="payment-row">
              <div className="payment-row__date">{formatDateShort(p.createdAt)}</div>
              <div className="payment-row__client">{clientName(p.clientId)}</div>
              <div className="payment-row__purpose">
                {p.purpose === 'subscription' ? 'Подписка' : 'Заказ'}
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

      {editing && (
        <div className="modal-backdrop no-drag" onClick={() => setEditing(null)}>
          <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editing.id ? 'Тариф' : 'Новый тариф'}</h2>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>Закрыть</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>Название</label>
                <input className="text-input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Цена в месяц, ₽</label>
                <input
                  className="text-input"
                  type="number"
                  value={editing.priceMonth}
                  onChange={(e) => setEditing({ ...editing, priceMonth: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Поручений в месяц</label>
                <input
                  className="text-input"
                  type="number"
                  value={editing.tasksPerMonth}
                  onChange={(e) => setEditing({ ...editing, tasksPerMonth: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Описание для агента</label>
                <textarea
                  className="text-input"
                  rows={3}
                  value={editing.description}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={editing.enabled}
                  onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
                />
                Тариф доступен для продажи
              </label>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn--primary" onClick={savePlan}>Сохранить</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

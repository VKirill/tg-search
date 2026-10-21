import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Category, Order, Service, ServiceKind } from '../../../shared/types';
import { formatPriceRange, formatRub, serviceKindLabel } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { IconPlus } from './Icons';
import { useToast } from './Toast';

const KINDS: ServiceKind[] = ['homework', 'marketplace_card', 'image_gen', 'copywriting'];

const INSTRUCTIONS_HINT =
  'Опишите скилл исполнителя: что делаем, что спросить у клиента, как оценивать сложность внутри вилки, планка качества, формат сдачи (файлы, текст, правки).';

type Draft = Omit<Service, 'id'> & { id?: number };

function emptyService(): Draft {
  return {
    kind: 'marketplace_card',
    name: '',
    categoryId: null,
    enabled: true,
    priceMin: 500,
    priceMax: 3000,
    instructions: '',
    model: '',
    previewEnabled: true,
    revisions: 2,
  };
}

function orderTotals(orders: Order[]) {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const inProgress = orders.filter((o) =>
    ['in_progress', 'revision', 'delivered', 'paid'].includes(o.status),
  ).length;
  const awaitingPayment = orders.filter((o) => o.status === 'awaiting_payment').length;
  const paidThisMonth = orders
    .filter((o) => o.paidAt != null && o.paidAt >= monthStart.getTime() && o.price != null)
    .reduce((s, o) => s + (o.price ?? 0), 0);
  return { inProgress, awaitingPayment, paidThisMonth };
}

export function ServicesView() {
  const toast = useToast();
  const [services, setServices] = useState<Service[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [svc, cats, ord] = await Promise.all([
        getApi().services.list(),
        getApi().categories.list(),
        getApi().orders.list(),
      ]);
      setServices(svc);
      setCategories(cats);
      setOrders(ord);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [toast]);

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'order:update') load();
    });
    return off;
  }, [load]);

  useEffect(() => {
    const open = location.hash.match(/service=(\d+)/);
    if (!open) return;
    const id = Number(open[1]);
    const s = services.find((x) => x.id === id);
    if (s) setEditing({ ...s });
  }, [services]);

  const totals = useMemo(() => orderTotals(orders), [orders]);

  const categoryName = (id: number | null) =>
    categories.find((c) => c.id === id)?.name ?? '—';

  const toggleEnabled = async (s: Service) => {
    try {
      await getApi().services.update(s.id, { enabled: !s.enabled });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    if (!editing) return;
    if (editing.priceMin > editing.priceMax) {
      setPriceError('Минимум не может быть больше максимума');
      return;
    }
    setPriceError(null);
    const { id, ...body } = editing;
    try {
      if (id) await getApi().services.update(id, body);
      else await getApi().services.create(body as Omit<Service, 'id'>);
      setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Удалить услугу? Заказы останутся в истории.')) return;
    try {
      await getApi().services.remove(id);
      if (editing?.id === id) setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page-view page-view--services">
      <div className="page-view__head">
        <h1>Исполнители</h1>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing(emptyService())}>
          <IconPlus /> Услуга
        </button>
      </div>

      <div className="services-stats-strip">
        <div className="services-stat">
          <span className="services-stat__value">{totals.inProgress}</span>
          <span className="services-stat__label">В работе</span>
        </div>
        <div className="services-stat">
          <span className="services-stat__value">{totals.awaitingPayment}</span>
          <span className="services-stat__label">Ждут оплаты</span>
        </div>
        <div className="services-stat">
          <span className="services-stat__value">{formatRub(totals.paidThisMonth)}</span>
          <span className="services-stat__label">Оплачено в этом месяце</span>
        </div>
      </div>

      {services.length === 0 ? (
        <div className="empty-state">Добавьте первую услугу — ИИ-менеджер сможет её продавать.</div>
      ) : (
        <div className="services-grid">
          {services.map((s) => (
            <article key={s.id} className={`service-card${s.enabled ? '' : ' service-card--off'}`}>
              <div className="service-card__head">
                <button
                  type="button"
                  className={`toggle${s.enabled ? ' toggle--on' : ''}`}
                  onClick={() => toggleEnabled(s)}
                  aria-label={s.enabled ? 'Выключить' : 'Включить'}
                />
                <div className="service-card__title">
                  <button type="button" className="service-card__name-btn" onClick={() => setEditing({ ...s })}>
                    {s.name}
                  </button>
                  <div className="service-card__meta">
                    <span className="tag">{serviceKindLabel(s.kind)}</span>
                    <span className="crm-muted">{categoryName(s.categoryId)}</span>
                  </div>
                </div>
              </div>
              <div className="service-card__price">{formatPriceRange(s.priceMin, s.priceMax)}</div>
              <div className="service-card__flags">
                {s.previewEnabled && <span className="badge">Превью</span>}
                <span className="badge">Правок: {s.revisions}</span>
              </div>
              <div className="service-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => setEditing({ ...s })}>Изменить</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(s.id)}>Удалить</button>
              </div>
            </article>
          ))}
        </div>
      )}

      {editing && (
        <div className="editor-sheet-backdrop" onClick={() => setEditing(null)}>
          <div className="editor-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="editor-sheet__head">
              <h2>{editing.id ? 'Редактор услуги' : 'Новая услуга'}</h2>
              <div className="editor-sheet__actions">
                <button type="button" className="btn btn--primary btn--sm" onClick={save}>Сохранить</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>Закрыть</button>
              </div>
            </div>
            <div className="editor-sheet__body">
              <div className="field">
                <label>Название</label>
                <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              </div>
              <div className="field">
                <label>Тип исполнителя</label>
                <select value={editing.kind} onChange={(e) => setEditing({ ...editing, kind: e.target.value as ServiceKind })}>
                  {KINDS.map((k) => <option key={k} value={k}>{serviceKindLabel(k)}</option>)}
                </select>
              </div>
              <div className="field">
                <label>Категория спроса</label>
                <select
                  value={editing.categoryId ?? ''}
                  onChange={(e) => setEditing({ ...editing, categoryId: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Не привязана</option>
                  {categories.filter((c) => c.enabled).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Цена от, ₽</label>
                  <input
                    type="number"
                    min={0}
                    value={editing.priceMin}
                    onChange={(e) => {
                      setPriceError(null);
                      setEditing({ ...editing, priceMin: Number(e.target.value) });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Цена до, ₽</label>
                  <input
                    type="number"
                    min={0}
                    value={editing.priceMax}
                    onChange={(e) => {
                      setPriceError(null);
                      setEditing({ ...editing, priceMax: Number(e.target.value) });
                    }}
                  />
                </div>
              </div>
              {priceError && <p className="field-error">{priceError}</p>}
              <div className="field">
                <label>Модель (пусто = по умолчанию)</label>
                <input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} />
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={editing.previewEnabled}
                  onChange={(e) => setEditing({ ...editing, previewEnabled: e.target.checked })}
                />
                Бесплатное превью до оплаты
              </label>
              <div className="field">
                <label>Бесплатных правок после сдачи</label>
                <input
                  type="number"
                  min={0}
                  value={editing.revisions}
                  onChange={(e) => setEditing({ ...editing, revisions: Number(e.target.value) })}
                />
              </div>
              <div className="field">
                <label>Инструкция-скилл</label>
                <p className="field-hint">{INSTRUCTIONS_HINT}</p>
                <textarea
                  className="crm-textarea"
                  rows={12}
                  value={editing.instructions}
                  onChange={(e) => setEditing({ ...editing, instructions: e.target.value })}
                />
              </div>
              {editing.id && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(editing.id!)}>
                  Удалить услугу
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

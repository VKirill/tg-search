import { useCallback, useEffect, useState } from 'react';
import type { Anamnesis, ClientCard, DealStage, Lead, Order, OrderFile, Service } from '../../../shared/types';
import { DEAL_STAGES, dealStageLabel, formatPriceRange, formatRub, orderStatusLabel } from '../utils/format';
import { isImageMime, mediaDisplayUrl } from '../utils/media';
import { renderMarkdown } from '../utils/markdown';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type CrmPanelProps = {
  lead: Lead | null;
  collapsed: boolean;
  onToggleCollapse: () => void;
};

export function CrmPanel({ lead, collapsed, onToggleCollapse }: CrmPanelProps) {
  const toast = useToast();
  const [card, setCard] = useState<ClientCard | null>(null);
  const [briefOpen, setBriefOpen] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [orders, setOrders] = useState<Order[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [dossierPath, setDossierPath] = useState<string | null>(null);
  const [newServiceId, setNewServiceId] = useState<number | ''>('');
  const [newBrief, setNewBrief] = useState('');

  const load = useCallback(async () => {
    if (!lead) {
      setCard(null);
      return;
    }
    try {
      const [c, ord, svc, folder] = await Promise.all([
        getApi().crm.get(lead.id),
        getApi().orders.list(lead.id),
        getApi().services.list(),
        getApi().dossier.path(lead.id),
      ]);
      setCard(c);
      setOrders(ord);
      setServices(svc.filter((s) => s.enabled));
      setDossierPath(folder);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [lead?.id, toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!lead) return;
    const off = getApi().onEvent((e) => {
      if (e.type === 'crm:update' && e.card.leadId === lead.id) setCard(e.card);
      if (e.type === 'order:update' && e.order.leadId === lead.id) {
        setOrders((prev) => {
          const i = prev.findIndex((o) => o.id === e.order.id);
          if (i < 0) return [e.order, ...prev];
          const next = [...prev];
          next[i] = e.order;
          return next;
        });
      }
    });
    return off;
  }, [lead?.id]);

  const patch = async (patch: Partial<ClientCard>) => {
    if (!lead) return;
    try {
      const c = await getApi().crm.update(lead.id, patch);
      setCard(c);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const updateAnamnesis = (field: keyof Anamnesis, value: string | string[]) => {
    if (!card) return;
    patch({ anamnesis: { ...card.anamnesis, [field]: value } });
  };

  if (collapsed) {
    return (
      <aside className="crm-panel crm-panel--collapsed">
        <button type="button" className="crm-panel__expand no-drag" onClick={onToggleCollapse} aria-label="Открыть CRM">
          CRM
        </button>
      </aside>
    );
  }

  if (!lead || !card) {
    return (
      <aside className="crm-panel">
        <div className="crm-panel__head">
          <span>CRM</span>
          <button type="button" className="btn btn--ghost btn--sm no-drag" onClick={onToggleCollapse}>›</button>
        </div>
        <div className="empty-state">Выберите диалог</div>
      </aside>
    );
  }

  const pct = card.completeness;

  return (
    <>
      <aside className="crm-panel">
        <div className="crm-panel__head">
          <span>Карточка клиента</span>
          <div className="crm-panel__head-actions">
            {dossierPath && (
              <button
                type="button"
                className="btn btn--sm no-drag"
                title={dossierPath}
                onClick={() => getApi().dossier.open(lead.id).catch((e) => toast(e instanceof Error ? e.message : String(e)))}
              >
                Папка клиента
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--sm no-drag" onClick={onToggleCollapse} aria-label="Свернуть">›</button>
          </div>
        </div>
        <div className="crm-panel__body scroll-list">
          <div className="field">
            <label>Этап</label>
            <select
              value={card.stage}
              onChange={(e) => patch({ stage: e.target.value as DealStage })}
            >
              {DEAL_STAGES.map((s) => (
                <option key={s} value={s}>{dealStageLabel(s)}</option>
              ))}
            </select>
          </div>
          <div className="completeness">
            <div className="completeness__ring" style={{ ['--pct' as string]: pct }}>
              <span>{pct}%</span>
            </div>
            <span className="completeness__label">Заполненность анамнеза</span>
          </div>
          <OrdersSection
            leadId={lead.id}
            orders={orders}
            services={services}
            serviceMap={new Map(services.map((s) => [s.id, s]))}
            newServiceId={newServiceId}
            newBrief={newBrief}
            onNewServiceId={setNewServiceId}
            onNewBrief={setNewBrief}
            onOrdersChange={setOrders}
            toast={toast}
          />
          <section className="crm-section">
            <h3>Саммари</h3>
            <textarea
              className="crm-textarea"
              value={card.summary}
              onChange={(e) => setCard({ ...card, summary: e.target.value })}
              onBlur={() => patch({ summary: card.summary })}
              rows={3}
            />
          </section>
          <section className="crm-section">
            <h3>Анамнез</h3>
            <AnamField label="Задача" value={card.anamnesis.task} onChange={(v) => updateAnamnesis('task', v)} />
            <AnamField label="Цель" value={card.anamnesis.goal} onChange={(v) => updateAnamnesis('goal', v)} />
            <AnamField label="Аудитория" value={card.anamnesis.audience} onChange={(v) => updateAnamnesis('audience', v)} />
            <AnamField label="Функционал" value={card.anamnesis.features.join(', ')} onChange={(v) => updateAnamnesis('features', v.split(',').map((s) => s.trim()).filter(Boolean))} />
            <AnamField label="Интеграции" value={card.anamnesis.integrations.join(', ')} onChange={(v) => updateAnamnesis('integrations', v.split(',').map((s) => s.trim()).filter(Boolean))} />
            <AnamField label="Стек" value={card.anamnesis.stack.join(', ')} onChange={(v) => updateAnamnesis('stack', v.split(',').map((s) => s.trim()).filter(Boolean))} />
            <AnamField label="Сроки" value={card.anamnesis.deadline} onChange={(v) => updateAnamnesis('deadline', v)} />
            <AnamField label="Бюджет" value={card.anamnesis.budget} onChange={(v) => updateAnamnesis('budget', v)} />
            <AnamField label="Контакты" value={card.anamnesis.contacts} onChange={(v) => updateAnamnesis('contacts', v)} />
            {card.anamnesis.openQuestions.length > 0 && (
              <div className="crm-open-q">
                <span className="crm-open-q__title">Открытые вопросы</span>
                <ul>{card.anamnesis.openQuestions.map((q) => <li key={q}>{q}</li>)}</ul>
              </div>
            )}
          </section>
          <section className="crm-section">
            <h3>ТЗ</h3>
            {card.brief ? (
              <div className="brief-preview markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.brief.slice(0, 400) + (card.brief.length > 400 ? '…' : '')) }} />
            ) : (
              <p className="crm-muted">ТЗ ещё не сформировано</p>
            )}
            <div className="crm-actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={generating}
                onClick={async () => {
                  setGenerating(true);
                  try {
                    setCard(await getApi().crm.generateBrief(lead.id));
                  } catch (e) {
                    toast(e instanceof Error ? e.message : String(e));
                  } finally {
                    setGenerating(false);
                  }
                }}
              >
                {card.brief ? 'Обновить ТЗ' : 'Сформировать ТЗ'}
              </button>
              {card.brief && (
                <>
                  <button type="button" className="btn btn--sm" onClick={() => navigator.clipboard.writeText(card.brief)}>Копировать</button>
                  <button type="button" className="btn btn--sm" onClick={() => setBriefOpen(true)}>На весь экран</button>
                </>
              )}
            </div>
          </section>
          <section className="crm-section">
            <h3>Заметки</h3>
            <textarea
              className="crm-textarea"
              value={card.notes}
              onChange={(e) => setCard({ ...card, notes: e.target.value })}
              onBlur={() => patch({ notes: card.notes })}
              rows={2}
            />
          </section>
          <button
            type="button"
            className="btn btn--sm"
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                setCard(await getApi().crm.refresh(lead.id));
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e));
              } finally {
                setRefreshing(false);
              }
            }}
          >
            {refreshing ? 'Обновляю…' : 'Обновить из переписки'}
          </button>
        </div>
      </aside>
      {briefOpen && card.brief && (
        <div className="modal-backdrop no-drag" onClick={() => setBriefOpen(false)}>
          <div className="modal-sheet modal-sheet--wide" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Техническое задание</h2>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => setBriefOpen(false)}>Закрыть</button>
            </div>
            <div className="modal-body markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(card.brief) }} />
          </div>
        </div>
      )}
    </>
  );
}

function AnamField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="anam-field">
      <span className="anam-field__label">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} onBlur={(e) => onChange(e.target.value)} />
    </div>
  );
}

type OrdersSectionProps = {
  leadId: number;
  orders: Order[];
  services: Service[];
  serviceMap: Map<number, Service>;
  newServiceId: number | '';
  newBrief: string;
  onNewServiceId: (v: number | '') => void;
  onNewBrief: (v: string) => void;
  onOrdersChange: (o: Order[]) => void;
  toast: (msg: string) => void;
};

function OrdersSection({
  leadId,
  orders,
  services,
  serviceMap,
  newServiceId,
  newBrief,
  onNewServiceId,
  onNewBrief,
  onOrdersChange,
  toast,
}: OrdersSectionProps) {
  const [priceDraft, setPriceDraft] = useState<Record<number, string>>({});
  const [expandedResult, setExpandedResult] = useState<Record<number, boolean>>({});

  const run = async (fn: () => Promise<Order>) => {
    try {
      const o = await fn();
      onOrdersChange(orders.map((x) => (x.id === o.id ? o : x)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const createOrder = async () => {
    if (newServiceId === '') {
      toast('Выберите услугу');
      return;
    }
    try {
      const o = await getApi().orders.create(leadId, newServiceId, newBrief);
      onOrdersChange([o, ...orders]);
      onNewBrief('');
      onNewServiceId('');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <section className="crm-section crm-section--orders">
      <h3>Заказы</h3>
      {orders.length === 0 && <p className="crm-muted">Пока нет заказов по этому лиду.</p>}
      {orders.map((o) => {
        const svc = serviceMap.get(o.serviceId);
        const name = svc?.name ?? `Услуга #${o.serviceId}`;
        const range = svc ? formatPriceRange(svc.priceMin, svc.priceMax) : '';
        return (
          <article key={o.id} className="order-card">
            <div className="order-card__head">
              <span className="order-card__title">{name}</span>
              <span className={`order-chip order-chip--${o.status}`}>{orderStatusLabel(o.status)}</span>
            </div>
            {o.price != null && <div className="order-card__price">{formatRub(o.price)}</div>}
            <label className="order-card__label">Хотелки и допущения</label>
            <textarea
              className="crm-textarea crm-textarea--sm"
              rows={2}
              value={o.brief}
              onChange={(e) => onOrdersChange(orders.map((x) => (x.id === o.id ? { ...x, brief: e.target.value } : x)))}
              onBlur={() => run(() => getApi().orders.update(o.id, { brief: o.brief }))}
            />
            {o.paymentUrl && (
              <div className="order-payment">
                <input className="text-input" readOnly value={o.paymentUrl} />
                <button type="button" className="btn btn--sm" onClick={() => navigator.clipboard.writeText(o.paymentUrl!)}>Копировать</button>
                <button type="button" className="btn btn--sm" onClick={() => getApi().shell.openExternal(o.paymentUrl!)}>Открыть</button>
              </div>
            )}
            <OrderFiles files={o.files} />
            {o.result && (
              <div className="order-result">
                <button type="button" className="order-result__toggle" onClick={() => setExpandedResult((p) => ({ ...p, [o.id]: !p[o.id] }))}>
                  Результат {expandedResult[o.id] ? '▾' : '▸'}
                </button>
                {expandedResult[o.id] && <p className="order-result__text">{o.result}</p>}
              </div>
            )}
            {o.error && <p className="order-error">{o.error}</p>}
            <div className="order-actions">
              {['collecting', 'quoted'].includes(o.status) && svc && (
                <div className="order-price-set">
                  <input
                    type="number"
                    placeholder={`${svc.priceMin}–${svc.priceMax}`}
                    value={priceDraft[o.id] ?? (o.price != null ? String(o.price) : '')}
                    onChange={(e) => setPriceDraft((p) => ({ ...p, [o.id]: e.target.value }))}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => {
                      const n = Number(priceDraft[o.id] ?? o.price);
                      if (!n || n < svc.priceMin || n > svc.priceMax) {
                        toast(`Цена в диапазоне ${range}`);
                        return;
                      }
                      run(() => getApi().orders.update(o.id, { price: n, status: 'quoted' }));
                    }}
                  >
                    Назначить цену
                  </button>
                </div>
              )}
              {['quoted', 'collecting'].includes(o.status) && o.price != null && (
                <button type="button" className="btn btn--sm" onClick={() => run(() => getApi().orders.requestPayment(o.id))}>
                  Выставить счёт
                </button>
              )}
              {o.status === 'awaiting_payment' && (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => {
                    if (!confirm('Подтвердить оплату вручную?')) return;
                    run(() => getApi().orders.markPaid(o.id));
                  }}
                >
                  Оплачено вручную
                </button>
              )}
              {['paid', 'revision'].includes(o.status) && (
                <button type="button" className="btn btn--sm" onClick={() => run(() => getApi().orders.run(o.id))}>
                  Выполнить
                </button>
              )}
              {['delivered', 'in_progress'].includes(o.status) && (
                <button type="button" className="btn btn--sm" onClick={() => run(() => getApi().orders.deliver(o.id))}>
                  Отправить клиенту
                </button>
              )}
              {!['cancelled', 'done'].includes(o.status) && (
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => run(() => getApi().orders.cancel(o.id))}>
                  Отменить
                </button>
              )}
            </div>
          </article>
        );
      })}
      <div className="order-new">
        <div className="order-new__title">Новый заказ</div>
        <select value={newServiceId} onChange={(e) => onNewServiceId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Услуга…</option>
          {services.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({formatPriceRange(s.priceMin, s.priceMax)})</option>
          ))}
        </select>
        <textarea
          className="crm-textarea crm-textarea--sm"
          rows={2}
          placeholder="Кратко: что хочет клиент"
          value={newBrief}
          onChange={(e) => onNewBrief(e.target.value)}
        />
        <button type="button" className="btn btn--sm" onClick={createOrder}>Создать</button>
      </div>
    </section>
  );
}

function OrderFiles({ files }: { files: OrderFile[] }) {
  if (files.length === 0) return null;
  const roles: OrderFile['role'][] = ['input', 'preview', 'output'];
  const labels: Record<OrderFile['role'], string> = { input: 'Вход', preview: 'Превью', output: 'Результат' };
  return (
    <div className="order-files">
      {roles.map((role) => {
        const group = files.filter((f) => f.role === role);
        if (group.length === 0) return null;
        return (
          <div key={role} className="order-files__group">
            <span className="order-files__label">{labels[role]}</span>
            <div className="order-files__grid">
              {group.map((f) => (
                <div key={f.path + f.name} className="order-file">
                  {isImageMime(f.mime) ? (
                    <img src={mediaDisplayUrl(f.path)} alt={f.name} className="order-file__thumb" />
                  ) : (
                    <span className="order-file__doc">{f.name}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

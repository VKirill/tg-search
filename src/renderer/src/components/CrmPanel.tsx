import { useCallback, useEffect, useState } from 'react';
import type { Anamnesis, ClientCard, DealStage, Lead } from '../../../shared/types';
import { DEAL_STAGES, dealStageLabel } from '../utils/format';
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

  const load = useCallback(async () => {
    if (!lead) {
      setCard(null);
      return;
    }
    try {
      setCard(await getApi().crm.get(lead.id));
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
          <button type="button" className="btn btn--ghost btn--sm no-drag" onClick={onToggleCollapse} aria-label="Свернуть">›</button>
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

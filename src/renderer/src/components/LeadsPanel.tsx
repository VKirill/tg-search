import type { Category, Lead, Source } from '../../../shared/types';
import {
  avatarColor,
  displayName,
  formatLeadDate,
  initials,
  leadLabelTag,
  leadStatusTag,
} from '../utils/format';
import { IconSearch, IconSort, IconThumbDown, IconThumbUp } from './Icons';

export type LeadSort = 'newest' | 'score';
export type LeadFilterChip = 'new' | 'handoff' | 'dialog' | 'replied' | 'hidden' | null;
export type LeadFilters = {
  chip: LeadFilterChip;
  sort: LeadSort;
};

type LeadsPanelProps = {
  title?: string;
  leads: Lead[];
  sources: Source[];
  categories: Category[];
  selectedLeadId: number | null;
  freshIds: Set<number>;
  search: string;
  filters: LeadFilters;
  hiddenCount: number;
  jobLabel: string | null;
  onSearch: (v: string) => void;
  onFilters: (f: LeadFilters) => void;
  onSelect: (id: number) => void;
  onFeedback: (leadId: number, value: 'up' | 'down' | null) => void;
  onMarkSpam?: (lead: Lead) => void;
};

export function LeadsPanel({
  title = 'Лиды',
  leads,
  sources,
  categories,
  selectedLeadId,
  freshIds,
  search,
  filters,
  hiddenCount,
  jobLabel,
  onSearch,
  onFilters,
  onSelect,
  onFeedback,
  onMarkSpam,
}: LeadsPanelProps) {
  const list = [...leads];

  const sourceTitle = (sourceId: number | null) => {
    if (!sourceId) return '—';
    return sources.find((s) => s.id === sourceId)?.title ?? 'Источник';
  };

  const toggleSort = () => {
    onFilters({ ...filters, sort: filters.sort === 'newest' ? 'score' : 'newest' });
  };

  return (
    <section className="panel panel--leads">
      <div className="panel-header">{title}</div>
      <div className="search-row">
        <div className="search-field">
          <IconSearch size={14} />
          <input
            placeholder="Поиск"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Поиск лидов"
          />
        </div>
      </div>
      <div className="leads-toolbar no-drag">
        <div className="filter-chips">
          {([
            ['new', 'Новые'],
            ['handoff', 'Нужен человек'],
            ['dialog', 'Диалог'],
            ['replied', 'Отвечено'],
            ['hidden', 'Скрытые'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`filter-chip${filters.chip === id ? ' filter-chip--active' : ''}`}
              onClick={() => onFilters({ ...filters, chip: filters.chip === id ? null : id })}
            >
              {label}
            </button>
          ))}
          <button type="button" className="icon-btn" onClick={toggleSort} title="Сортировка" aria-label="Сортировка">
            <IconSort />
          </button>
        </div>
      </div>
      <div className="leads-stats">
        Совпадений: {list.length} · {hiddenCount} скрыто
      </div>
      {jobLabel && <div className="activity-line">{jobLabel}</div>}
      <div className="scroll-list">
        {list.map((lead) => {
          const name = displayName(lead);
          const category = categories.find((c) => c.id === lead.categoryId);
          return (
            <article
              key={lead.id}
              className={`lead-card${selectedLeadId === lead.id ? ' lead-card--selected' : ''}${
                freshIds.has(lead.id) ? ' lead-card--fresh' : ''
              }`}
              onClick={() => onSelect(lead.id)}
              title={`ИИ: ${lead.reason}`}
            >
              <div className="lead-card__head">
                <div className="avatar" style={{ background: avatarColor(name) }}>
                  {initials(name)}
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="lead-card__title">{name}</div>
                  {lead.authorUsername && <div className="lead-card__username">@{lead.authorUsername}</div>}
                  <div className="lead-card__source">{sourceTitle(lead.sourceId)}</div>
                  {lead.authorUserId == null && (
                    <div className="lead-card__no-contact">Контакт пока не определён</div>
                  )}
                </div>
                <span className="score-badge">{lead.score}%</span>
              </div>
              <p className="lead-card__text">{lead.text}</p>
              <div className="lead-card__badges">
                {category && <span className="tag tag--category">{category.name}</span>}
                {lead.handoff && <span className="tag tag--warn">передача</span>}
                {lead.repeatCount > 0 && (
                  <span className="tag tag--muted">повторил {lead.repeatCount} раз</span>
                )}
                {lead.sequenceStep > 0 && lead.nextStepAt && <span className="tag">цепочка {lead.sequenceStep}</span>}
              </div>
              <div className="lead-card__row">
                <div className="tags">
                  <span className="tag">{leadLabelTag(lead.label)}</span>
                  <span className="tag">{leadStatusTag(lead.status)}</span>
                </div>
                <div className="lead-card__actions no-drag" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onFeedback(lead.id, lead.feedback === 'up' ? null : 'up')}
                    aria-label="Нравится"
                  >
                    <IconThumbUp filled={lead.feedback === 'up'} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => onFeedback(lead.id, lead.feedback === 'down' ? null : 'down')}
                    aria-label="Не нравится"
                  >
                    <IconThumbDown filled={lead.feedback === 'down'} />
                  </button>
                  {onMarkSpam && (
                    <button
                      type="button"
                      className="btn btn--xs btn--ghost"
                      onClick={() => {
                        if (!confirm('Пометить как спам?')) return;
                        onMarkSpam(lead);
                      }}
                    >
                      Спам
                    </button>
                  )}
                </div>
              </div>
              <div className="lead-card__date">{formatLeadDate(lead.date)}</div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

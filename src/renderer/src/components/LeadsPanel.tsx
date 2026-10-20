import type { Lead, Source } from '../../../shared/types';
import {
  avatarColor,
  displayName,
  formatLeadDate,
  initials,
  leadLabelTag,
  leadStatusTag,
} from '../utils/format';
import {
  IconFilterHidden,
  IconFilterLiked,
  IconFilterReplied,
  IconSearch,
  IconSort,
  IconThumbDown,
  IconThumbUp,
} from './Icons';

export type LeadSort = 'newest' | 'score';
export type LeadFilters = {
  likedOnly: boolean;
  repliedOnly: boolean;
  showHidden: boolean;
  sort: LeadSort;
};

type LeadsPanelProps = {
  leads: Lead[];
  sources: Source[];
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
};

export function LeadsPanel({
  leads,
  sources,
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
}: LeadsPanelProps) {
  let list = [...leads];
  if (filters.likedOnly) list = list.filter((l) => l.feedback === 'up');
  if (filters.repliedOnly) list = list.filter((l) => l.status === 'replied' || l.status === 'dialog');
  if (!filters.showHidden) list = list.filter((l) => l.status !== 'hidden');
  if (filters.sort === 'score') list.sort((a, b) => b.score - a.score);
  else list.sort((a, b) => b.date - a.date);

  const sourceTitle = (sourceId: number | null) => {
    if (!sourceId) return '—';
    return sources.find((s) => s.id === sourceId)?.title ?? 'Источник';
  };

  const toggleSort = () => {
    onFilters({ ...filters, sort: filters.sort === 'newest' ? 'score' : 'newest' });
  };

  return (
    <section className="panel panel--leads">
      <div className="panel-header">Лиды</div>
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
        <div className="filter-group">
          <button
            type="button"
            className={`icon-btn${filters.likedOnly ? ' icon-btn--active' : ''}`}
            onClick={() => onFilters({ ...filters, likedOnly: !filters.likedOnly })}
            title="Только с оценкой «нравится»"
            aria-label="Только понравившиеся"
          >
            <IconFilterLiked active={filters.likedOnly} />
          </button>
          <button
            type="button"
            className={`icon-btn${filters.repliedOnly ? ' icon-btn--active' : ''}`}
            onClick={() => onFilters({ ...filters, repliedOnly: !filters.repliedOnly })}
            title="С ответом"
            aria-label="С ответом"
          >
            <IconFilterReplied active={filters.repliedOnly} />
          </button>
          <button
            type="button"
            className={`icon-btn${filters.showHidden ? ' icon-btn--active' : ''}`}
            onClick={() => onFilters({ ...filters, showHidden: !filters.showHidden })}
            title="Показать скрытые"
            aria-label="Скрытые"
          >
            <IconFilterHidden active={filters.showHidden} />
          </button>
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

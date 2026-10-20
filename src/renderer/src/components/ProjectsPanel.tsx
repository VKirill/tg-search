import type { Account, Project, Source } from '../../../shared/types';
import { avatarColor, initials } from '../utils/format';
import { IconLightning, IconPlus, IconSearch } from './Icons';

type ProjectsPanelProps = {
  projects: Project[];
  accounts: Account[];
  sources: Source[];
  selectedId: number | null;
  search: string;
  onSearch: (v: string) => void;
  onSelect: (id: number) => void;
  onNewProject: () => void;
  onAccounts: () => void;
};

export function ProjectsPanel({
  projects,
  accounts,
  sources,
  selectedId,
  search,
  onSearch,
  onSelect,
  onNewProject,
  onAccounts,
}: ProjectsPanelProps) {
  const q = search.toLowerCase();
  const filtered = projects.filter((p) => !q || p.name.toLowerCase().includes(q));

  const leadCounts = new Map<number, number>();
  // counts filled by parent via optional prop would be better; compute from sources matchedLeads sum per project as proxy
  for (const p of projects) {
    const srcs = sources.filter((s) => s.projectId === p.id);
    const matches = srcs.reduce((n, s) => n + s.matchedLeads, 0);
    leadCounts.set(p.id, matches);
  }

  return (
    <aside className="panel panel--projects">
      <div className="panel-header">Проекты</div>
      <div className="search-row">
        <div className="search-field">
          <IconSearch size={14} />
          <input
            placeholder="Поиск"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Поиск проектов"
          />
        </div>
      </div>
      <div className="scroll-list">
        {filtered.map((p) => {
          const srcN = sources.filter((s) => s.projectId === p.id).length;
          const matchN = leadCounts.get(p.id) ?? 0;
          const ap = p.autopilot.enabled;
          return (
            <div
              key={p.id}
              className={`project-item${selectedId === p.id ? ' project-item--active' : ''}`}
              onClick={() => onSelect(p.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && onSelect(p.id)}
            >
              <div className="avatar" style={{ background: avatarColor(p.name) }}>
                {initials(p.name)}
              </div>
              <div className="project-item__body">
                <div className="project-item__name">{p.name}</div>
                <div className="project-item__meta">{srcN} источников · {matchN} совпадений</div>
                <div className={`project-item__auto${ap ? ' project-item__auto--on' : ''}`}>
                  {ap && <IconLightning />}
                  {ap ? 'Автопилот · включён' : 'На паузе'}
                </div>
              </div>
            </div>
          );
        })}
        <button type="button" className="btn btn--ghost add-row-btn" onClick={onNewProject}>
          <IconPlus size={14} /> Новый проект
        </button>
      </div>
      <div className="panel-footer">
        <div className="account-switcher">
          {accounts.slice(0, 2).map((a) => {
            const left = a.dailyLimit - a.sentToday;
            const pct = a.dailyLimit ? (a.sentToday / a.dailyLimit) * 100 : 0;
            const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || a.username || a.phone;
            return (
              <div key={a.id} className="account-mini" onClick={onAccounts} role="button" tabIndex={0}>
                <div className="account-mini__name">{name}</div>
                <div className="limit-bar">
                  <div className="limit-bar__fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="limit-bar__label">
                  Израсходовано {a.sentToday} из {a.dailyLimit}
                </div>
              </div>
            );
          })}
          <button type="button" className="btn btn--sm btn--ghost" onClick={onAccounts}>
            <IconPlus size={14} /> Аккаунты
          </button>
        </div>
      </div>
    </aside>
  );
}

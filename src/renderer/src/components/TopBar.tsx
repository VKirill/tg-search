import type { Account, Project } from '../../../shared/types';
import { IconSettings } from './Icons';

type TopBarProps = {
  project: Project | null;
  accounts: Account[];
  sourceCount: number;
  onSources: () => void;
  onAutopilot: () => void;
  onSettings: () => void;
};

export function TopBar({ project, accounts, sourceCount, onSources, onAutopilot, onSettings }: TopBarProps) {
  const projectAccounts = project
    ? accounts.filter((a) => project.accountIds.includes(a.id))
    : [];
  const names = projectAccounts.map((a) => a.firstName ?? a.username ?? a.phone).join(', ');
  const apOn = project?.autopilot.enabled ?? false;

  return (
    <header className="top-bar">
      <div className="top-bar__left">
        <span className="top-bar__title">{project?.name ?? 'TG Search'}</span>
        {names && <span className="top-bar__accounts">{names}</span>}
      </div>
      <div className="top-bar__right no-drag">
        <button type="button" className="btn btn--sm" onClick={onSources}>
          Источники {sourceCount}
        </button>
        <button
          type="button"
          className={`autopilot-pill no-drag${apOn ? ' autopilot-pill--on' : ''}`}
          onClick={onAutopilot}
        >
          <span className="autopilot-pill__dot" />
          Автопилот
        </button>
        <button type="button" className="icon-btn no-drag" onClick={onSettings} aria-label="Настройки">
          <IconSettings />
        </button>
      </div>
    </header>
  );
}

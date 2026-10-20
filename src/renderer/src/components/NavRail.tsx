import type React from 'react';
import { IconAccounts, IconBroadcast, IconFunnel, IconInbox, IconLeads, IconSettings, IconTopics } from './Icons';
import type { Account } from '../../../shared/types';

export type NavView =
  | 'inbox'
  | 'leads'
  | 'funnel'
  | 'projects'
  | 'broadcasts'
  | 'accounts'
  | 'settings';

type NavRailProps = {
  view: NavView;
  collapsed: boolean;
  accounts: Account[];
  onView: (v: NavView) => void;
  onToggleCollapse: () => void;
};

const items: { id: NavView; label: string; Icon: (p: { size?: number }) => React.ReactElement }[] = [
  { id: 'inbox', label: 'Входящие', Icon: IconInbox },
  { id: 'leads', label: 'Лиды', Icon: IconLeads },
  { id: 'funnel', label: 'Воронка', Icon: IconFunnel },
  { id: 'projects', label: 'Тематики', Icon: IconTopics },
  { id: 'broadcasts', label: 'Рассылки', Icon: IconBroadcast },
  { id: 'accounts', label: 'Аккаунты', Icon: IconAccounts },
  { id: 'settings', label: 'Настройки', Icon: IconSettings },
];

export function NavRail({ view, collapsed, accounts, onView, onToggleCollapse }: NavRailProps) {
  return (
    <nav className={`nav-rail${collapsed ? ' nav-rail--collapsed' : ''}`} aria-label="Навигация">
      <div className="nav-rail__drag" />
      <button type="button" className="nav-rail__toggle no-drag" onClick={onToggleCollapse} aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}>
        {collapsed ? '»' : '«'}
      </button>
      <ul className="nav-rail__list no-drag">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`nav-rail__item${view === item.id ? ' nav-rail__item--active' : ''}`}
              onClick={() => onView(item.id)}
              title={item.label}
            >
              <span className="nav-rail__icon" aria-hidden><item.Icon size={17} /></span>
              {!collapsed && <span className="nav-rail__label">{item.label}</span>}
            </button>
          </li>
        ))}
      </ul>
      <div className="nav-rail__limits no-drag">
        {accounts.slice(0, 2).map((a) => {
          const pct = Math.min(100, (a.sentToday / a.dailyLimit) * 100);
          return (
            <div key={a.id} className="nav-rail__limit" title={a.phone}>
              {!collapsed && <div className="nav-rail__limit-name">{a.firstName ?? a.phone}</div>}
              <div className="limit-bar">
                <div className="limit-bar__fill" style={{ width: `${pct}%` }} />
              </div>
              {!collapsed && (
                <div className="limit-bar__label">{a.sentToday}/{a.dailyLimit} сегодня</div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}

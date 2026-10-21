import type React from 'react';
import {
  IconAccounts,
  IconAgents,
  IconApprovals,
  IconBroadcast,
  IconChats,
  IconFunnel,
  IconInbox,
  IconLeads,
  IconServices,
  IconSettings,
  IconSkills,
  IconNews,
  IconGroups,
  IconSpam,
  IconStats,
  IconSubscriptions,
  IconTopics,
} from './Icons';
import type { Account } from '../../../shared/types';

export type NavView =
  | 'inbox'
  | 'chats'
  | 'groups'
  | 'leads'
  | 'funnel'
  | 'projects'
  | 'broadcasts'
  | 'services'
  | 'subscriptions'
  | 'agents'
  | 'skills'
  | 'approvals'
  | 'news'
  | 'stats'
  | 'spam'
  | 'accounts'
  | 'settings';

type NavRailProps = {
  view: NavView;
  collapsed: boolean;
  accounts: Account[];
  pendingApprovals?: number;
  onView: (v: NavView) => void;
  onToggleCollapse: () => void;
};

const items: { id: NavView; label: string; Icon: (p: { size?: number }) => React.ReactElement; badge?: boolean }[] = [
  { id: 'inbox', label: 'Входящие', Icon: IconInbox },
  { id: 'chats', label: 'Чаты', Icon: IconChats },
  { id: 'groups', label: 'Помощник групп', Icon: IconGroups },
  { id: 'leads', label: 'Лиды', Icon: IconLeads },
  { id: 'funnel', label: 'Воронка', Icon: IconFunnel },
  { id: 'projects', label: 'Тематики', Icon: IconTopics },
  { id: 'broadcasts', label: 'Рассылки', Icon: IconBroadcast },
  { id: 'services', label: 'Исполнители', Icon: IconServices },
  { id: 'subscriptions', label: 'Подписки', Icon: IconSubscriptions },
  { id: 'agents', label: 'Агенты', Icon: IconAgents },
  { id: 'skills', label: 'Умения', Icon: IconSkills },
  { id: 'approvals', label: 'Согласования', Icon: IconApprovals, badge: true },
  { id: 'news', label: 'Новости', Icon: IconNews },
  { id: 'stats', label: 'Статистика', Icon: IconStats },
  { id: 'spam', label: 'Спам', Icon: IconSpam },
  { id: 'accounts', label: 'Аккаунты', Icon: IconAccounts },
  { id: 'settings', label: 'Настройки', Icon: IconSettings },
];

export function NavRail({ view, collapsed, accounts, pendingApprovals = 0, onView, onToggleCollapse }: NavRailProps) {
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
              <span className="nav-rail__icon" aria-hidden>
                <item.Icon size={17} />
                {item.badge && pendingApprovals > 0 && (
                  <span className="nav-badge">{pendingApprovals > 9 ? '9+' : pendingApprovals}</span>
                )}
              </span>
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

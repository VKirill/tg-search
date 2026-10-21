import { useCallback, useEffect, useState } from 'react';
import type { Approval, Lead } from '../../../shared/types';
import { formatLeadDate } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type Tab = 'pending' | 'history';

type Props = {
  leads: Lead[];
  onPendingCount?: (n: number) => void;
};

export function ApprovalsView({ leads, onPendingCount }: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<Approval[]>([]);

  const load = useCallback(async () => {
    const list = await getApi().approvals.list(tab === 'pending' ? 'pending' : undefined);
    const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt);
    if (tab === 'history') {
      setItems(sorted.filter((a) => a.status !== 'pending'));
    } else {
      setItems(sorted.filter((a) => a.status === 'pending'));
    }
  }, [tab]);

  useEffect(() => {
    load().catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [load, toast]);

  useEffect(() => {
    const off = getApi().onEvent((e) => {
      if (e.type === 'approval:update') load();
    });
    return off;
  }, [load]);

  useEffect(() => {
    if (tab !== 'pending') return;
    onPendingCount?.(items.length);
  }, [items, tab, onPendingCount]);

  useEffect(() => {
    getApi()
      .approvals.list('pending')
      .then((list) => onPendingCount?.(list.length))
      .catch(() => {});
  }, [onPendingCount]);

  const leadName = (leadId: number) => {
    const l = leads.find((x) => x.id === leadId);
    return l?.authorName ?? `Лид #${leadId}`;
  };

  const decide = async (id: number, approve: boolean) => {
    try {
      await getApi().approvals.decide(id, approve);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const pendingCount = tab === 'pending' ? items.length : undefined;

  return (
    <div className="page-view page-view--approvals">
      <div className="page-view__head">
        <h1>
          Согласования
          {pendingCount != null && pendingCount > 0 && (
            <span className="nav-badge nav-badge--inline">{pendingCount}</span>
          )}
        </h1>
      </div>
      <div className="skills-tabs">
        <button type="button" className={`filter-chip${tab === 'pending' ? ' filter-chip--active' : ''}`} onClick={() => setTab('pending')}>
          Ожидают
        </button>
        <button type="button" className={`filter-chip${tab === 'history' ? ' filter-chip--active' : ''}`} onClick={() => setTab('history')}>
          История
        </button>
      </div>

      {items.length === 0 ? (
        <div className="empty-state">{tab === 'pending' ? 'Нет запросов на согласование.' : 'История пуста.'}</div>
      ) : (
        <ul className="approval-list">
          {items.map((a) => (
            <li key={a.id} className="approval-card">
              <div className="approval-card__head">
                <div>
                  <div className="approval-card__lead">{leadName(a.leadId)}</div>
                  <div className="crm-muted">Агент {a.agent} · {a.tool}</div>
                </div>
                <time className="crm-muted">{formatLeadDate(a.createdAt)}</time>
              </div>
              <p className="approval-card__summary">{a.summary}</p>
              {tab === 'pending' ? (
                <div className="approval-card__actions">
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => decide(a.id, true)}>Разрешить</button>
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => decide(a.id, false)}>Отклонить</button>
                </div>
              ) : (
                <div className="approval-card__status">
                  <span className={`tag${a.status === 'approved' ? ' tag--ok' : ' tag--warn'}`}>
                    {a.status === 'approved' ? 'Разрешено' : 'Отклонено'}
                  </span>
                  {a.decidedAt != null && <span className="crm-muted">{formatLeadDate(a.decidedAt)}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

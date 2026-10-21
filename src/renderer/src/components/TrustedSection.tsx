import { useCallback, useEffect, useState } from 'react';
import type { TrustedContact } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

// «Свои люди»: their tasks are free; the agent can write to them once a day to ask for tasks
export function TrustedSection() {
  const toast = useToast();
  const [list, setList] = useState<TrustedContact[]>([]);
  const [username, setUsername] = useState('');
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);
  const load = useCallback(() => getApi().trusted.list().then(setList, fail), [fail]);

  useEffect(() => {
    load();
  }, [load]);

  const save = (c: Pick<TrustedContact, 'username'> & Partial<TrustedContact>) => getApi().trusted.save(c).then(load, fail);

  return (
    <section>
      <h2 className="section-title">Свои люди</h2>
      <p className="crm-muted">Их задания агент выполняет бесплатно и отвечает им, даже когда автоответы клиентам выключены.</p>
      <div className="news-add">
        <input value={username} placeholder="@username" onChange={(e) => setUsername(e.target.value)} />
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => username.trim() && save({ username, free: true }).then(() => setUsername(''))}
        >
          Добавить
        </button>
      </div>
      <ul className="trusted-list">
        {list.map((c) => (
          <li key={c.username}>
            <span className="trusted-list__name">@{c.username}</span>
            <label>
              <input type="checkbox" checked={c.free} onChange={(e) => save({ ...c, free: e.target.checked })} /> бесплатно
            </label>
            <label title={c.lastCheckinAt ? `последний раз ${formatLeadDate(c.lastCheckinAt)}` : 'ещё не писал'}>
              <input type="checkbox" checked={c.dailyCheckin} onChange={(e) => save({ ...c, dailyCheckin: e.target.checked })} /> писать каждый день в
            </label>
            <select value={c.checkinHour} onChange={(e) => save({ ...c, checkinHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${h}:00`}</option>)}
            </select>
            <button type="button" className="btn btn--sm btn--ghost" aria-label="Убрать" onClick={() => getApi().trusted.remove(c.username).then(load, fail)}>×</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

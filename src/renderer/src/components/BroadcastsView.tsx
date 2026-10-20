import { useEffect, useState } from 'react';
import type { Account, Broadcast, BroadcastInput } from '../../../shared/types';
import { formatLeadDate } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type BroadcastsViewProps = {
  accounts: Account[];
};

export function BroadcastsView({ accounts }: BroadcastsViewProps) {
  const toast = useToast();
  const [list, setList] = useState<Broadcast[]>([]);
  const [editing, setEditing] = useState<Broadcast | 'new' | null>(null);

  const load = () => {
    getApi()
      .broadcasts.list()
      .then(setList)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'broadcast:update') load();
    });
    return off;
  }, [toast]);

  const toggle = async (b: Broadcast) => {
    try {
      await getApi().broadcasts.update(b.id, { enabled: !b.enabled });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const runNow = async (id: number) => {
    try {
      const r = await getApi().broadcasts.runNow(id);
      toast(`Отправлено: ${r.posted}, пропущено: ${r.skipped}, ошибок: ${r.errors}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: number) => {
    if (!confirm('Удалить рассылку?')) return;
    await getApi().broadcasts.remove(id);
    load();
  };

  return (
    <div className="page-view">
      <div className="page-view__head">
        <h1>Рассылки</h1>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>Создать</button>
      </div>
      <div className="broadcast-list">
        {list.map((b) => (
          <article key={b.id} className="broadcast-card">
            <div className="broadcast-card__head">
              <button type="button" className={`toggle${b.enabled ? ' toggle--on' : ''}`} onClick={() => toggle(b)} aria-label="Вкл/выкл" />
              <div>
                <div className="broadcast-card__name">{b.name}</div>
                <div className="broadcast-card__meta">Каждые {b.intervalHours} ч · {b.chats.length} чатов</div>
              </div>
              <div className="broadcast-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => setEditing(b)}>Изменить</button>
                <button type="button" className="btn btn--sm" onClick={() => runNow(b.id)}>Отправить сейчас</button>
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => remove(b.id)}>Удалить</button>
              </div>
            </div>
            <p className="broadcast-card__text">{b.text}</p>
            <table className="sources-table">
              <thead>
                <tr>
                  <th>Чат</th>
                  <th>Последний пост</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {b.chats.map((c) => (
                  <tr key={c.tgChatId}>
                    <td>{c.title}{c.username ? ` @${c.username}` : ''}</td>
                    <td>{c.lastPostedAt ? formatLeadDate(c.lastPostedAt) : '—'}</td>
                    <td className={c.lastError ? 'danger-text' : ''}>{c.lastError ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </article>
        ))}
        {list.length === 0 && <div className="empty-state">Нет рассылок</div>}
      </div>
      {editing && (
        <BroadcastForm
          accounts={accounts}
          initial={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
}

function BroadcastForm({
  accounts,
  initial,
  onClose,
  onSaved,
}: {
  accounts: Account[];
  initial: Broadcast | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState(initial?.name ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const [accountIds, setAccountIds] = useState<number[]>(initial?.accountIds ?? [accounts[0]?.id ?? 1]);
  const [chatLinks, setChatLinks] = useState(initial?.chats.map((c) => c.username ? `@${c.username}` : c.title).join('\n') ?? '');
  const [intervalHours, setIntervalHours] = useState(initial?.intervalHours ?? 72);
  const [spin, setSpin] = useState(initial?.spin ?? true);

  const save = async () => {
    const input: BroadcastInput = {
      name,
      text,
      accountIds,
      chatLinks: chatLinks.split('\n').map((s) => s.trim()).filter(Boolean),
      intervalHours,
      spin,
    };
    try {
      if (initial) await getApi().broadcasts.update(initial.id, input);
      else await getApi().broadcasts.create(input);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet modal-sheet--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{initial ? 'Редактировать рассылку' : 'Новая рассылка'}</h2>
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Закрыть</button>
        </div>
        <div className="modal-body">
          <div className="field"><label>Название</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field">
            <label>Текст ({text.length} симв.)</label>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4} />
          </div>
          <div className="field">
            <label>Аккаунты</label>
            {accounts.map((a) => (
              <label key={a.id} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={accountIds.includes(a.id)}
                  onChange={(e) => setAccountIds(e.target.checked ? [...accountIds, a.id] : accountIds.filter((id) => id !== a.id))}
                />
                {a.firstName ?? a.phone}
              </label>
            ))}
          </div>
          <div className="field">
            <label>Ссылки на чаты (по одной на строку)</label>
            <textarea value={chatLinks} onChange={(e) => setChatLinks(e.target.value)} rows={4} />
          </div>
          <div className="field">
            <label>Интервал (часов)</label>
            <input type="number" value={intervalHours} onChange={(e) => setIntervalHours(Number(e.target.value))} />
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={spin} onChange={(e) => setSpin(e.target.checked)} />
            Менять формулировку ИИ
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="button" className="btn btn--primary" onClick={save}>Сохранить</button>
        </div>
      </div>
    </div>
  );
}

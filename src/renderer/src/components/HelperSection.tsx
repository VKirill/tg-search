import { useCallback, useEffect, useState } from 'react';
import type { Account, HelperChat, HelperRequest } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const STATUS: Record<HelperRequest['status'], string> = {
  ignored: 'не задача', asked: 'уточняет', queued: 'в очереди', solving: 'решает', done: 'решено', failed: 'ошибка', limit: 'лимит',
};

// «Чат ГДЗ»: groups where the agent solves tasks for everyone — Jev filters requests, the solver answers in a reply
export function HelperSection({ cap, onCap, pause, onPause }: { cap: string; onCap: (v: string) => void; pause: string; onPause: (v: string) => void }) {
  const toast = useToast();
  const api = getApi();
  const [chats, setChats] = useState<HelperChat[]>([]);
  const [requests, setRequests] = useState<HelperRequest[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [link, setLink] = useState('');
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  const load = useCallback(() => {
    api.helper.chats().then(setChats, fail);
    api.helper.requests(15).then(setRequests, () => {});
  }, [api, fail]);
  useEffect(() => {
    load();
    api.accounts.list().then((list) => setAccounts(list.filter((a) => a.status === 'authorized')), () => {});
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [api, load]);

  const add = () => {
    const account = accounts[0];
    if (!account || !link.trim()) return;
    api.helper.addChat(account.id, link).then((list) => {
      setChats(list);
      setLink('');
    }, fail);
  };
  const save = (list: HelperChat[]) => api.helper.saveChats(list).then(setChats, fail);

  return (
    <section>
      <h2 className="section-title">Чат ГДЗ — решение задач в группе</h2>
      <p className="field-hint">
        Агент слушает группу: Jev решает, просят ли решить задачу; если на фото несколько заданий — агент спрашивает, какое решить
        (номер или «все»), и отвечает решением на сообщение автора. Остальные сообщения агент не трогает.
      </p>
      <ul className="trusted-list">
        {chats.map((c) => (
          <li key={c.chatId}>
            <span className="trusted-list__name">{c.username ? `@${c.username}` : c.title}</span>
            <label>
              <input type="checkbox" checked={c.enabled} onChange={(e) => save(chats.map((x) => (x.chatId === c.chatId ? { ...x, enabled: e.target.checked } : x)))} /> отвечать
            </label>
            <span className="crm-muted">{c.title}</span>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Отключить чат «${c.title}»?`) && save(chats.filter((x) => x.chatId !== c.chatId))}>×</button>
          </li>
        ))}
      </ul>
      <div className="news-add">
        <input value={link} placeholder="https://t.me/gdz_chat_all" onChange={(e) => setLink(e.target.value)} />
        <button type="button" className="btn btn--sm btn--primary" disabled={!accounts.length} onClick={add}>Подключить</button>
      </div>
      <div className="field">
        <label>Бесплатных решений одному участнику в день (0 — без лимита; дальше агент зовёт в личку) — сохраняется кнопкой «Сохранить»</label>
        <input value={cap} onChange={(e) => onCap(e.target.value)} />
      </div>
      <div className="field">
        <label>Пауза между ответами помощника в группе, секунд (у рассылок своя пауза аккаунта) — сохраняется кнопкой «Сохранить»</label>
        <input value={pause} onChange={(e) => onPause(e.target.value)} />
      </div>
      {requests.length > 0 && (
        <ul className="helper-log">
          {requests.map((r) => (
            <li key={r.id}>
              <span className={`tag${r.status === 'failed' ? ' tag--warn' : r.status === 'done' ? ' tag--category' : ''}`}>{STATUS[r.status]}</span>
              <span className="helper-log__who">{r.userName || r.userId}</span>
              <span className="helper-log__text">{r.text || (r.photos.length ? `[фото${r.tasks.length ? `: задания ${r.tasks.join(', ')}` : ''}]` : '')}{r.selection ? ` → ${r.selection === 'all' ? 'все' : r.selection}` : ''}</span>
              <span className="crm-muted">{formatLeadDate(r.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

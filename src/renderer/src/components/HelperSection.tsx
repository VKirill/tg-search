import { useCallback, useEffect, useState } from 'react';
import { HELPER_SCENARIOS, type Account, type HelperChat, type HelperRequest, type HelperScenario } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const STATUS: Record<HelperRequest['status'], string> = {
  ignored: 'не запрос', asked: 'уточняет', queued: 'в очереди', solving: 'отвечает', done: 'ответил', failed: 'ошибка', limit: 'лимит',
};

// «Помощник в группах»: in the groups the owner connects, the agent answers members by a scenario
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
    const t = setInterval(() => api.helper.requests(15).then(setRequests, () => {}), 15_000);
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
  const patch = (chatId: number, p: Partial<HelperChat>) => setChats((list) => list.map((c) => (c.chatId === chatId ? { ...c, ...p } : c)));
  const patchSave = (chatId: number, p: Partial<HelperChat>) => save(chats.map((c) => (c.chatId === chatId ? { ...c, ...p } : c)));

  return (
    <section>
      <h2 className="section-title">Помощник в группах</h2>
      <p className="field-hint">
        Агент работает в подключённых группах: Jev отделяет запросы участников от остальных сообщений, агент отвечает реплаем на
        сообщение автора — по сценарию группы. Остальные сообщения он не трогает. Описание группы и правила хранятся только на этом компьютере.
      </p>
      {chats.map((c) => {
        const scenario = c.scenario ?? 'tasks';
        return (
          <div key={c.chatId} className="helper-chat">
            <div className="helper-chat__head">
              <span className="trusted-list__name">{c.username ? `@${c.username}` : c.title}</span>
              <span className="crm-muted">{c.title}</span>
              <label>
                <input type="checkbox" checked={c.enabled} onChange={(e) => patchSave(c.chatId, { enabled: e.target.checked })} /> работает
              </label>
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Отключить помощника в «${c.title}»?`) && save(chats.filter((x) => x.chatId !== c.chatId))}>×</button>
            </div>
            <div className="field">
              <label>Сценарий</label>
              <select value={scenario} onChange={(e) => patchSave(c.chatId, { scenario: e.target.value as HelperScenario })}>
                {Object.entries(HELPER_SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <p className="field-hint">{HELPER_SCENARIOS[scenario].description}</p>
            </div>
            <div className="field">
              <label>О чём группа — по этому Jev понимает, что считать запросом, а агент — о чём отвечать</label>
              <textarea rows={2} value={c.about ?? ''} placeholder="Например: помощь с домашкой для школьников 5–11 классов" onChange={(e) => patch(c.chatId, { about: e.target.value })} onBlur={() => save(chats)} />
            </div>
            <div className="field">
              <label>Как отвечать (необязательно)</label>
              <textarea rows={2} value={c.instructions ?? ''} placeholder="Тон, длина, чего не делать, куда направлять с личными вопросами" onChange={(e) => patch(c.chatId, { instructions: e.target.value })} onBlur={() => save(chats)} />
            </div>
            <div className="helper-chat__opts">
              <label title="Ответы приходят от имени группы (аккаунт — анонимный администратор); без этого — от аккаунта, с реакцией 🔥">
                <input type="checkbox" checked={c.asGroup !== false} onChange={(e) => patchSave(c.chatId, { asGroup: e.target.checked })} /> от имени группы
              </label>
              {scenario === 'tasks' && (
                <label title="Если на фото несколько заданий — опрос автору, какие решить">
                  <input type="checkbox" checked={c.askWhich !== false} onChange={(e) => patchSave(c.chatId, { askWhich: e.target.checked })} /> спрашивать, какие задания решить
                </label>
              )}
              <label>
                лимит в день на участника
                <input className="helper-chat__cap" value={c.dailyCap ?? ''} placeholder={cap} onChange={(e) => patch(c.chatId, { dailyCap: e.target.value === '' ? null : Number(e.target.value) || 0 })} onBlur={() => save(chats)} />
              </label>
            </div>
          </div>
        );
      })}
      <div className="news-add">
        <input value={link} placeholder="https://t.me/имя_группы" onChange={(e) => setLink(e.target.value)} />
        <button type="button" className="btn btn--sm btn--primary" disabled={!accounts.length} onClick={add}>Подключить группу</button>
      </div>
      <div className="field-row">
        <div className="field">
          <label>Лимит ответов участнику в день по умолчанию (0 — без лимита)</label>
          <input value={cap} onChange={(e) => onCap(e.target.value)} />
        </div>
        <div className="field">
          <label>Пауза между ответами помощника, секунд</label>
          <input value={pause} onChange={(e) => onPause(e.target.value)} />
        </div>
      </div>
      <p className="field-hint">Эти два поля сохраняются кнопкой «Сохранить»; настройки групп — сразу. «Свои люди» лимита не имеют.</p>
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

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HELPER_DEFAULT_JEV,
  HELPER_DEFAULT_TEXTS,
  HELPER_SCENARIOS,
  type Account,
  type AgentDef,
  type HelperChat,
  type HelperRequest,
  type HelperScenario,
  type Settings,
  type SkillDef,
} from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const STATUS: Record<HelperRequest['status'], string> = {
  ignored: 'не запрос', asked: 'уточняет', queued: 'в очереди', solving: 'отвечает', done: 'ответил', failed: 'ошибка', limit: 'лимит',
};

// «Помощник групп»: the agent answers members in connected groups and channel discussions — each group has its scenario,
// filters, Jev question, agent, skills and phrases; a sandbox and a log of what it answered
export function GroupsView() {
  const toast = useToast();
  const api = getApi();
  const [chats, setChats] = useState<HelperChat[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [draft, setDraft] = useState<HelperChat | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [link, setLink] = useState('');
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  useEffect(() => {
    api.helper.chats().then((list) => {
      setChats(list);
      setSelected((s) => s ?? list[0]?.chatId ?? null);
    }, fail);
    api.accounts.list().then((list) => setAccounts(list.filter((a) => a.status === 'authorized')), () => {});
    api.agents.list().then((list) => setAgents(list.filter((a) => a.mode === 'subagent')), () => {});
    api.skills.list().then((list) => setSkills(list.filter((s) => s.status === 'active')), () => {});
    api.settings.get().then(setSettings, () => {});
  }, [api, fail]);

  const current = chats.find((c) => c.chatId === selected) ?? null;
  useEffect(() => setDraft(current ? { ...current } : null), [current]);
  const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== JSON.stringify(current), [draft, current]);

  const save = async () => {
    if (!draft) return;
    try {
      setChats(await api.helper.saveChats(chats.map((c) => (c.chatId === draft.chatId ? draft : c))));
      toast('Сохранено');
    } catch (e) {
      fail(e);
    }
  };
  const add = async () => {
    const account = accounts[0];
    if (!account || !link.trim()) return;
    try {
      const list = await api.helper.addChat(account.id, link);
      setChats(list);
      setSelected(list[list.length - 1]?.chatId ?? null);
      setLink('');
    } catch (e) {
      fail(e);
    }
  };
  const remove = async (c: HelperChat) => {
    if (!confirm(`Отключить помощника в «${c.title}»?`)) return;
    const list = await api.helper.saveChats(chats.filter((x) => x.chatId !== c.chatId)).catch((e) => (fail(e), chats));
    setChats(list);
    setSelected(list[0]?.chatId ?? null);
  };
  const saveCommon = (patch: Partial<Settings>) => api.settings.set(patch).then(setSettings, fail);

  return (
    <div className="page-view groups-view">
      <div className="page-view__head">
        <h1>Помощник групп</h1>
        {draft && <button type="button" className="btn btn--primary btn--sm" disabled={!dirty} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
      </div>
      <p className="field-hint">
        Агент работает в ваших группах и обсуждениях каналов: отбирает сообщения, на которые нужно ответить, и отвечает реплаем — по сценарию группы.
        Описание групп, правила и тексты хранятся только на этом компьютере.
      </p>
      <div className="groups-layout">
        <aside className="groups-list">
          {chats.map((c) => (
            <button key={c.chatId} type="button" className={`groups-list__item${c.chatId === selected ? ' groups-list__item--active' : ''}`} onClick={() => setSelected(c.chatId)}>
              <span className={`status-dot${c.enabled ? ' status-dot--ok' : ''}`} />
              <span className="groups-list__name">{c.channel ? c.channel.title : c.title}</span>
              <span className="crm-muted">{c.channel ? 'канал · ' : ''}{HELPER_SCENARIOS[c.scenario ?? 'tasks'].label}</span>
            </button>
          ))}
          {!chats.length && <p className="crm-muted">Групп пока нет</p>}
          <div className="groups-add">
            <input className="text-input" value={link} placeholder="t.me/группа или канал" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button type="button" className="btn btn--sm" disabled={!accounts.length || !link.trim()} onClick={add}>Подключить</button>
          </div>
          {settings && (
            <div className="groups-common">
              <h2 className="section-title">Для всех групп</h2>
              <div className="field">
                <label>Ответов участнику в день (0 — без лимита)</label>
                <input value={settings.helperDailyPerUser} onChange={(e) => setSettings({ ...settings, helperDailyPerUser: e.target.value })} onBlur={() => saveCommon({ helperDailyPerUser: settings.helperDailyPerUser })} />
              </div>
              <div className="field">
                <label>Пауза между ответами, секунд</label>
                <input value={settings.helperPauseSec} onChange={(e) => setSettings({ ...settings, helperPauseSec: e.target.value })} onBlur={() => saveCommon({ helperPauseSec: settings.helperPauseSec })} />
              </div>
              <p className="field-hint">«Свои люди» лимита не имеют. Рассылки ждут свою паузу аккаунта.</p>
            </div>
          )}
        </aside>
        {draft ? (
          <GroupEditor draft={draft} setDraft={setDraft} accounts={accounts} agents={agents} skills={skills} onRemove={() => remove(draft)} />
        ) : (
          <div className="empty-state">Подключите группу или канал по ссылке слева</div>
        )}
      </div>
    </div>
  );
}

function GroupEditor({ draft, setDraft, accounts, agents, skills, onRemove }: {
  draft: HelperChat;
  setDraft: (c: HelperChat) => void;
  accounts: Account[];
  agents: AgentDef[];
  skills: SkillDef[];
  onRemove: () => void;
}) {
  const api = getApi();
  const toast = useToast();
  const scenario: HelperScenario = draft.scenario ?? 'tasks';
  const set = (p: Partial<HelperChat>) => setDraft({ ...draft, ...p });
  const setText = (key: 'ack' | 'fail' | 'limit', v: string) => set({ texts: { ...draft.texts, [key]: v } });
  const [probe, setProbe] = useState('');
  const [verdict, setVerdict] = useState<{ score: number; answer: boolean; reason: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [log, setLog] = useState<HelperRequest[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const load = () => api.helper.requests(30, draft.chatId).then(setLog, () => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [api, draft.chatId]);

  const test = async () => {
    setTesting(true);
    try {
      setVerdict(await api.helper.test(draft, probe));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="groups-editor">
      <section className="settings-card">
        <div className="settings-card__head">
          <h2 className="settings-card__title">{draft.channel ? `Канал «${draft.channel.title}»` : draft.title}</h2>
          <span className="crm-muted">{draft.channel ? `обсуждение: ${draft.title}` : draft.username ? `@${draft.username}` : ''}</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={onRemove}>Отключить</button>
        </div>
        <div className="helper-chat__opts">
          <label><input type="checkbox" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> работает</label>
          <label title="Ответы от имени группы (аккаунт — анонимный администратор; реакций нет, вместо них короткое «взял…»); без этого — от аккаунта, с реакцией 🔥">
            <input type="checkbox" checked={draft.asGroup !== false} onChange={(e) => set({ asGroup: e.target.checked })} /> от имени группы
          </label>
          <label>
            аккаунт
            <select value={draft.accountId} onChange={(e) => set({ accountId: Number(e.target.value) })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.phone}</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Сценарий</h2>
        <div className="groups-scenarios">
          {Object.entries(HELPER_SCENARIOS).map(([k, v]) => (
            <button key={k} type="button" className={`groups-scenario${scenario === k ? ' groups-scenario--active' : ''}`} onClick={() => set({ scenario: k as HelperScenario })}>
              <b>{v.label}</b>
              <span>{v.description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">О группе</h2>
        <div className="field">
          <label>О чём группа — контекст для Jev и агента</label>
          <textarea rows={2} value={draft.about ?? ''} placeholder="Например: помощь с домашкой для школьников 5–11 классов" onChange={(e) => set({ about: e.target.value })} />
        </div>
        <div className="field">
          <label>Как отвечать</label>
          <textarea rows={2} value={draft.instructions ?? ''} placeholder="Тон, длина, чего не делать, куда направлять с личными вопросами" onChange={(e) => set({ instructions: e.target.value })} />
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">На какие сообщения отвечать</h2>
        <div className="helper-chat__opts">
          <label><input type="checkbox" checked={!!draft.repliesOnly} onChange={(e) => set({ repliesOnly: e.target.checked })} /> только ответы помощнику и упоминания аккаунта</label>
          {scenario === 'tasks' && (
            <label><input type="checkbox" checked={draft.askWhich !== false} onChange={(e) => set({ askWhich: e.target.checked })} /> несколько заданий на фото — опрос автору</label>
          )}
        </div>
        <div className="field">
          <label>Ключевые слова — отвечать только на сообщения с ними (через запятую; пусто — на любые)</label>
          <input value={(draft.keywords ?? []).join(', ')} placeholder="реши, помогите, как сделать" onChange={(e) => set({ keywords: e.target.value.split(',').map((w) => w.trim()).filter(Boolean) })} />
        </div>
        <div className="helper-chat__opts">
          <label><input type="checkbox" checked={draft.jevCheck !== false} onChange={(e) => set({ jevCheck: e.target.checked })} /> проверка Jev</label>
          {draft.jevCheck !== false && (
            <label>
              порог, %
              <input className="helper-chat__cap" value={Math.round((draft.threshold ?? 0.5) * 100)} onChange={(e) => set({ threshold: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 })} />
            </label>
          )}
        </div>
        {draft.jevCheck !== false && (
          <div className="field">
            <label>
              Вопрос Jev о каждом сообщении (по-английски — так Jev точнее; `message` — текст, `picture` — что на фото, `group` — описание группы)
              {draft.jevPrompt?.trim() ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => set({ jevPrompt: '' })}>вернуть стандартный</button> : null}
            </label>
            <textarea rows={4} value={draft.jevPrompt || HELPER_DEFAULT_JEV[scenario]} onChange={(e) => set({ jevPrompt: e.target.value === HELPER_DEFAULT_JEV[scenario] ? '' : e.target.value })} />
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Кто отвечает</h2>
        <div className="field">
          <label>Агент (правится в «Агентах»)</label>
          <select value={draft.agent ?? ''} onChange={(e) => set({ agent: e.target.value || undefined })}>
            <option value="">по сценарию — {HELPER_SCENARIOS[scenario].agent}</option>
            {agents.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.description.slice(0, 60)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Умения, которые агент получает с каждым запросом (правятся в «Умениях»)</label>
          <div className="needs-row">
            {skills.map((s) => {
              const on = (draft.skills ?? []).includes(s.name);
              return (
                <label key={s.name} className={`chip-check${on ? ' chip-check--on' : ''}`} title={s.description}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ skills: e.target.checked ? [...(draft.skills ?? []), s.name] : (draft.skills ?? []).filter((x) => x !== s.name) })} />
                  {s.name}
                </label>
              );
            })}
            {!skills.length && <span className="crm-muted">активных умений нет</span>}
          </div>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Что пишет помощник</h2>
        {(['ack', 'fail', 'limit'] as const).map((key) => (
          <div className="field" key={key}>
            <label>{key === 'ack' ? 'Когда взял запрос (только от имени группы; удаляется с приходом ответа)' : key === 'fail' ? 'Если не получилось' : 'Когда лимит на сегодня исчерпан ({cap} — число)'}</label>
            <input value={draft.texts?.[key] ?? ''} placeholder={HELPER_DEFAULT_TEXTS[scenario][key]} onChange={(e) => setText(key, e.target.value)} />
          </div>
        ))}
        <div className="field">
          <label>Ответов участнику в день в этой группе (пусто — как для всех)</label>
          <input value={draft.dailyCap ?? ''} onChange={(e) => set({ dailyCap: e.target.value === '' ? null : Number(e.target.value) || 0 })} />
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Песочница</h2>
        <p className="field-hint">Что скажут фильтры и Jev о сообщении с текущими (даже не сохранёнными) настройками. В группу ничего не уходит.</p>
        <div className="route-check">
          <textarea className="text-input" rows={2} value={probe} placeholder="Например: помогите решить №5, не понимаю как" onChange={(e) => setProbe(e.target.value)} />
          <button type="button" className="btn btn--sm" disabled={testing || !probe.trim()} onClick={test}>{testing ? 'Jev думает…' : 'Проверить'}</button>
        </div>
        {verdict && (
          <p className={`groups-verdict${verdict.answer ? ' groups-verdict--yes' : ''}`}>
            {verdict.answer ? 'Ответит' : 'Не ответит'} — {verdict.reason}
          </p>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Журнал</h2>
        <ul className="helper-log">
          {log.map((r) => (
            <li key={r.id} className="helper-log__row">
              <button type="button" className="helper-log__line" onClick={() => setOpen(open === r.id ? null : r.id)}>
                <span className={`tag${r.status === 'failed' ? ' tag--warn' : r.status === 'done' ? ' tag--category' : ''}`}>{STATUS[r.status]}</span>
                <span className="helper-log__who">{r.userName || r.userId}</span>
                <span className="helper-log__text">{r.text || (r.photos.length ? `[фото${r.tasks.length ? `: задания ${r.tasks.join(', ')}` : ''}]` : '')}{r.selection ? ` → ${r.selection === 'all' ? 'все' : r.selection}` : ''}</span>
                {r.score != null && <span className="crm-muted" title="Jev">{Math.round(r.score * 100)}%</span>}
                <span className="crm-muted">{formatLeadDate(r.createdAt)}</span>
              </button>
              {open === r.id && (
                <div className="helper-log__detail">
                  {r.agent && <div className="crm-muted">агент: {r.agent}</div>}
                  {r.error && <div className="field-error">{r.error}</div>}
                  <pre>{r.answer ?? 'ответа нет'}</pre>
                </div>
              )}
            </li>
          ))}
          {!log.length && <li className="crm-muted">Запросов пока не было</li>}
        </ul>
      </section>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HELPER_DEFAULT_JEV,
  HELPER_DEFAULT_TEXTS,
  HELPER_KINDS,
  type Account,
  type AgentDef,
  type AiModel,
  type HelperChat,
  type HelperKind,
  type HelperRequest,
  type HelperScenarioDef,
  type KnowledgeBase,
  type KnowledgeDoc,
  type KnowledgeHit,
  type Settings,
  type SkillDef,
} from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const STATUS: Record<HelperRequest['status'], string> = {
  ignored: 'не запрос', asked: 'уточняет', queued: 'в очереди', solving: 'отвечает', done: 'ответил', failed: 'ошибка', limit: 'лимит',
};

type Pick = { kind: 'group'; id: number } | { kind: 'scenario'; id: string } | { kind: 'base'; id: number } | null;

// «Помощник групп»: groups (where and about what), scenarios (how to answer: filters, Jev, agents, model, checking,
// knowledge, phrases) and knowledge bases; a group follows one scenario, a scenario serves many groups
export function GroupsView() {
  const toast = useToast();
  const api = getApi();
  const [chats, setChats] = useState<HelperChat[]>([]);
  const [scenarios, setScenarios] = useState<HelperScenarioDef[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [pick, setPick] = useState<Pick>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [link, setLink] = useState('');
  const [newBase, setNewBase] = useState('');
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  useEffect(() => {
    api.helper.chats().then((list) => {
      setChats(list);
      setPick((p) => p ?? (list[0] ? { kind: 'group', id: list[0].chatId } : null));
    }, fail);
    api.helper.scenarios().then(setScenarios, fail);
    api.knowledge.bases().then(setBases, () => {});
    api.accounts.list().then((list) => setAccounts(list.filter((a) => a.status === 'authorized')), () => {});
    api.agents.list().then((list) => setAgents(list.filter((a) => a.mode === 'subagent')), () => {});
    api.skills.list().then((list) => setSkills(list.filter((x) => x.status === 'active')), () => {});
    api.ai.models().then((v) => setModels(v.models), () => {});
    api.settings.get().then(setSettings, () => {});
  }, [api, fail]);

  const add = async () => {
    const account = accounts[0];
    if (!account || !link.trim()) return;
    try {
      const list = await api.helper.addChat(account.id, link);
      setChats(list);
      const last = list[list.length - 1];
      if (last) setPick({ kind: 'group', id: last.chatId });
      setLink('');
    } catch (e) {
      fail(e);
    }
  };
  const newScenario = async (from?: HelperScenarioDef) => {
    const base: HelperScenarioDef = from
      ? { ...from, id: '', builtIn: undefined, name: `${from.name} — копия` }
      : { id: '', name: 'Новый сценарий', description: '', kind: 'questions', mode: 'agent', verify: 'agent' };
    const list = await api.helper.saveScenario(base).catch((e) => (fail(e), null));
    if (!list) return null;
    setScenarios(list);
    const created = list[list.length - 1];
    setPick({ kind: 'scenario', id: created.id });
    return created;
  };
  const saveCommon = (patch: Partial<Settings>) => api.settings.set(patch).then(setSettings, fail);
  const group = pick?.kind === 'group' ? chats.find((c) => c.chatId === pick.id) : undefined;
  const scenario = pick?.kind === 'scenario' ? scenarios.find((x) => x.id === pick.id) : undefined;
  const base = pick?.kind === 'base' ? bases.find((b) => b.id === pick.id) : undefined;

  return (
    <div className="page-view groups-view">
      <div className="page-view__head">
        <h1>Помощник групп</h1>
      </div>
      <p className="field-hint">
        Агент работает в ваших группах и обсуждениях каналов. <b>Сценарий</b> задаёт, как отвечать: на какие сообщения, каким агентом или
        моделью, с какой проверкой, по каким материалам и что писать. <b>Группа</b> — где и о чём; у каждой свой сценарий, один сценарий может
        работать во многих группах. Всё это хранится только на этом компьютере.
      </p>
      <div className="groups-layout">
        <aside className="groups-list">
          <h2 className="section-title">Группы</h2>
          {chats.map((c) => (
            <button key={c.chatId} type="button" className={`groups-list__item${pick?.kind === 'group' && pick.id === c.chatId ? ' groups-list__item--active' : ''}`} onClick={() => setPick({ kind: 'group', id: c.chatId })}>
              <span className={`status-dot${c.enabled ? ' status-dot--ok' : ''}`} />
              <span className="groups-list__name">{c.channel ? c.channel.title : c.title}</span>
              <span className="crm-muted">{c.channel ? 'канал · ' : ''}{scenarios.find((x) => x.id === (c.scenario ?? 'tasks'))?.name ?? '—'}</span>
            </button>
          ))}
          {!chats.length && <p className="crm-muted">Групп пока нет</p>}
          <div className="groups-add">
            <input className="text-input" value={link} placeholder="t.me/группа или канал" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button type="button" className="btn btn--sm" disabled={!accounts.length || !link.trim()} onClick={add}>Подключить</button>
          </div>

          <div className="groups-common">
            <h2 className="section-title">Сценарии</h2>
            {scenarios.map((x) => (
              <button key={x.id} type="button" className={`groups-list__item${pick?.kind === 'scenario' && pick.id === x.id ? ' groups-list__item--active' : ''}`} onClick={() => setPick({ kind: 'scenario', id: x.id })}>
                <span className={`status-dot${chats.some((c) => (c.scenario ?? 'tasks') === x.id) ? ' status-dot--ok' : ''}`} />
                <span className="groups-list__name">{x.name}</span>
                <span className="crm-muted">{HELPER_KINDS[x.kind].label}{x.builtIn ? ' · встроенный' : ''}</span>
              </button>
            ))}
            <button type="button" className="btn btn--sm groups-new" onClick={() => newScenario()}>+ Новый сценарий</button>
          </div>

          <div className="groups-common">
            <h2 className="section-title">Базы знаний</h2>
            {bases.map((b) => (
              <button key={b.id} type="button" className={`groups-list__item${pick?.kind === 'base' && pick.id === b.id ? ' groups-list__item--active' : ''}`} onClick={() => setPick({ kind: 'base', id: b.id })}>
                <span className="status-dot status-dot--ok" />
                <span className="groups-list__name">{b.name}</span>
                <span className="crm-muted">{b.docs} док. · {b.chunks} фрагм.</span>
              </button>
            ))}
            <div className="groups-add">
              <input className="text-input" value={newBase} placeholder="Новая база: книги, справка…" onChange={(e) => setNewBase(e.target.value)} />
              <button type="button" className="btn btn--sm" disabled={!newBase.trim()} onClick={() => api.knowledge.createBase(newBase, '').then((list) => {
                setBases(list);
                const created = list.find((b) => b.name === newBase.trim());
                if (created) setPick({ kind: 'base', id: created.id });
                setNewBase('');
              }, fail)}>Создать</button>
            </div>
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

        {group ? (
          <GroupEditor
            key={group.chatId} group={group} scenarios={scenarios} accounts={accounts}
            onSave={(g) => api.helper.saveChats(chats.map((c) => (c.chatId === g.chatId ? g : c))).then((l) => { setChats(l); toast('Сохранено'); }, fail)}
            onRemove={() => confirm(`Отключить помощника в «${group.title}»?`) && api.helper.saveChats(chats.filter((c) => c.chatId !== group.chatId)).then((l) => { setChats(l); setPick(null); }, fail)}
            onOpenScenario={(id) => setPick({ kind: 'scenario', id })}
            onCopyScenario={async (from) => {
              const created = await newScenario(from);
              if (created) setChats(await api.helper.saveChats(chats.map((c) => (c.chatId === group.chatId ? { ...c, scenario: created.id } : c))));
            }}
          />
        ) : scenario ? (
          <ScenarioEditor
            key={scenario.id} scenario={scenario} groups={chats} agents={agents} skills={skills} models={models} bases={bases}
            onSave={(d) => api.helper.saveScenario(d).then((l) => { setScenarios(l); toast('Сценарий сохранён'); }, fail)}
            onReset={() => api.helper.removeScenario(scenario.id).then((l) => {
              setScenarios(l);
              if (!scenario.builtIn) {
                setPick(null);
                api.helper.chats().then(setChats, () => {});
              }
            }, fail)}
            onCopy={() => newScenario(scenario)}
          />
        ) : base ? (
          <KnowledgeEditor base={base} onBases={setBases} onRemoved={() => setPick(null)} />
        ) : (
          <div className="empty-state">Подключите группу или канал по ссылке слева, выберите сценарий или базу знаний</div>
        )}
      </div>
    </div>
  );
}

// A group: where the helper works, about what, by which scenario; the sandbox and the log
function GroupEditor({ group, scenarios, accounts, onSave, onRemove, onOpenScenario, onCopyScenario }: {
  group: HelperChat;
  scenarios: HelperScenarioDef[];
  accounts: Account[];
  onSave: (g: HelperChat) => void;
  onRemove: () => void;
  onOpenScenario: (id: string) => void;
  onCopyScenario: (from: HelperScenarioDef) => void;
}) {
  const api = getApi();
  const [draft, setDraft] = useState<HelperChat>(group);
  const dirty = JSON.stringify(draft) !== JSON.stringify(group);
  const set = (p: Partial<HelperChat>) => setDraft({ ...draft, ...p });
  const sc = scenarios.find((x) => x.id === (draft.scenario ?? 'tasks')) ?? scenarios[0];
  const [log, setLog] = useState<HelperRequest[]>([]);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const load = () => api.helper.requests(30, group.chatId).then(setLog, () => {});
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [api, group.chatId]);

  return (
    <div className="groups-editor">
      <section className="settings-card">
        <div className="settings-card__head">
          <h2 className="settings-card__title">{draft.channel ? `Канал «${draft.channel.title}»` : draft.title}</h2>
          <span className="crm-muted">{draft.channel ? `обсуждение: ${draft.title}` : draft.username ? `@${draft.username}` : ''}</span>
          <button type="button" className="btn btn--sm btn--primary" disabled={!dirty} onClick={() => onSave(draft)}>{dirty ? 'Сохранить' : 'Сохранено'}</button>
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
          <label>
            лимит в день на участника
            <input className="helper-chat__cap" value={draft.dailyCap ?? ''} placeholder="общий" onChange={(e) => set({ dailyCap: e.target.value === '' ? null : Number(e.target.value) || 0 })} />
          </label>
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Сценарий</h2>
        <div className="field">
          <select value={sc?.id ?? ''} onChange={(e) => set({ scenario: e.target.value })}>
            {scenarios.map((x) => <option key={x.id} value={x.id}>{x.name}{x.builtIn ? '' : ' (свой)'}</option>)}
          </select>
          {sc && <p className="field-hint">{sc.description}</p>}
        </div>
        {sc && (
          <div className="helper-chat__opts">
            <button type="button" className="btn btn--sm" onClick={() => onOpenScenario(sc.id)}>Открыть сценарий</button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onCopyScenario(sc)}>Сделать свой на его основе</button>
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">О группе</h2>
        <div className="field">
          <label>О чём группа — контекст для Jev и агента</label>
          <textarea rows={2} value={draft.about ?? ''} placeholder="Например: помощь с домашкой для школьников 5–11 классов" onChange={(e) => set({ about: e.target.value })} />
        </div>
        <div className="field">
          <label>Как отвечать в этой группе</label>
          <textarea rows={2} value={draft.instructions ?? ''} placeholder="Тон, длина, чего не делать, куда направлять с личными вопросами" onChange={(e) => set({ instructions: e.target.value })} />
        </div>
      </section>

      <Sandbox group={draft} />

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

// The sandbox: what filters and Jev say about a message, and the whole answer — with the group's settings and, in the
// scenario editor, its unsaved edits; nothing goes to the group
function Sandbox({ group, scenario, groups }: { group?: HelperChat; scenario?: HelperScenarioDef; groups?: HelperChat[] }) {
  const api = getApi();
  const toast = useToast();
  const [target, setTarget] = useState<number | null>(group?.chatId ?? groups?.[0]?.chatId ?? null);
  const chat = group ?? groups?.find((g) => g.chatId === target);
  const [probe, setProbe] = useState('');
  const [verdict, setVerdict] = useState<{ score: number; answer: boolean; reason: string } | null>(null);
  const [preview, setPreview] = useState<{ answer: string; ms: number } | null>(null);
  const [busy, setBusy] = useState<'test' | 'preview' | null>(null);
  const run = async (what: 'test' | 'preview') => {
    if (!chat) return;
    setBusy(what);
    try {
      if (what === 'test') setVerdict(await api.helper.test(chat, probe, scenario));
      else {
        setPreview(null);
        setPreview(await api.helper.preview(chat, probe, scenario));
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="settings-card">
      <h2 className="settings-card__title">Песочница</h2>
      <p className="field-hint">«Проверить» — что скажут фильтры и Jev; «Показать ответ» — что ответил бы помощник целиком (знания, агенты или модель, проверка). С текущими, даже не сохранёнными, настройками. В группу ничего не уходит.</p>
      {!group && groups && (
        <div className="field">
          <label>Группа — её тема и правила</label>
          <select value={target ?? ''} onChange={(e) => setTarget(Number(e.target.value))}>
            {groups.map((g) => <option key={g.chatId} value={g.chatId}>{g.title}</option>)}
          </select>
        </div>
      )}
      {!chat ? <p className="crm-muted">Подключите группу, чтобы проверить сценарий на её теме.</p> : (
        <>
          <div className="route-check">
            <textarea className="text-input" rows={2} value={probe} placeholder="Например: помогите решить №5, не понимаю как" onChange={(e) => setProbe(e.target.value)} />
            <div className="helper-chat__opts">
              <button type="button" className="btn btn--sm" disabled={!!busy || !probe.trim()} onClick={() => run('test')}>{busy === 'test' ? 'Jev думает…' : 'Проверить'}</button>
              <button type="button" className="btn btn--sm" disabled={!!busy || !probe.trim()} onClick={() => run('preview')}>{busy === 'preview' ? 'Готовит ответ…' : 'Показать ответ'}</button>
            </div>
          </div>
          {verdict && <p className={`groups-verdict${verdict.answer ? ' groups-verdict--yes' : ''}`}>{verdict.answer ? 'Ответит' : 'Не ответит'} — {verdict.reason}</p>}
          {preview && (
            <div className="helper-log__detail">
              <div className="crm-muted">ответ за {Math.round(preview.ms / 1000)} с</div>
              <pre>{preview.answer}</pre>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// A scenario: which messages get an answer, how it is made, what the helper writes
function ScenarioEditor({ scenario, groups, agents, skills, models, bases, onSave, onReset, onCopy }: {
  scenario: HelperScenarioDef;
  groups: HelperChat[];
  agents: AgentDef[];
  skills: SkillDef[];
  models: AiModel[];
  bases: KnowledgeBase[];
  onSave: (d: HelperScenarioDef) => void;
  onReset: () => void;
  onCopy: () => void;
}) {
  const [draft, setDraft] = useState<HelperScenarioDef>(scenario);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(scenario), [draft, scenario]);
  const set = (p: Partial<HelperScenarioDef>) => setDraft({ ...draft, ...p });
  const kind: HelperKind = draft.kind;
  const usedBy = groups.filter((g) => (g.scenario ?? 'tasks') === scenario.id);
  const mainAgent = draft.agent || HELPER_KINDS[kind].agent;
  const chips = <T extends string | number>(all: { key: T; label: string; title?: string }[], value: T[] | undefined, onChange: (v: T[]) => void) => (
    <div className="needs-row">
      {all.map((x) => {
        const on = (value ?? []).includes(x.key);
        return (
          <label key={String(x.key)} className={`chip-check${on ? ' chip-check--on' : ''}`} title={x.title}>
            <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? [...(value ?? []), x.key] : (value ?? []).filter((v) => v !== x.key))} />
            {x.label}
          </label>
        );
      })}
      {!all.length && <span className="crm-muted">пока нет</span>}
    </div>
  );

  return (
    <div className="groups-editor">
      <section className="settings-card">
        <div className="settings-card__head">
          <h2 className="settings-card__title">Сценарий{scenario.builtIn ? ' · встроенный' : ''}</h2>
          <span className="crm-muted">{usedBy.length ? `в группах: ${usedBy.map((g) => g.title).join(', ')}` : 'пока ни в одной группе'}</span>
          <button type="button" className="btn btn--sm btn--primary" disabled={!dirty} onClick={() => onSave(draft)}>{dirty ? 'Сохранить' : 'Сохранено'}</button>
          <button type="button" className="btn btn--sm" onClick={onCopy}>Копия</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(scenario.builtIn ? 'Вернуть встроенный сценарий к исходным настройкам?' : `Удалить сценарий «${scenario.name}»? Его группы перейдут на «Решение задач».`) && onReset()}>
            {scenario.builtIn ? 'Сбросить' : 'Удалить'}
          </button>
        </div>
        <div className="field">
          <label>Название</label>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>Что делает — видно при выборе сценария в группе</label>
          <textarea rows={2} value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="groups-scenarios groups-scenarios--two">
          {(Object.keys(HELPER_KINDS) as HelperKind[]).map((k) => (
            <button key={k} type="button" className={`groups-scenario${kind === k ? ' groups-scenario--active' : ''}`} onClick={() => set({ kind: k })}>
              <b>{HELPER_KINDS[k].label}</b>
              <span>{HELPER_KINDS[k].description}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">На какие сообщения отвечать</h2>
        <div className="helper-chat__opts">
          <label><input type="checkbox" checked={!!draft.repliesOnly} onChange={(e) => set({ repliesOnly: e.target.checked })} /> только ответы помощнику и упоминания аккаунта</label>
          {kind === 'tasks' && <label><input type="checkbox" checked={draft.askWhich !== false} onChange={(e) => set({ askWhich: e.target.checked })} /> несколько заданий на фото — опрос автору</label>}
        </div>
        <div className="field">
          <label>Ключевые слова — только сообщения с ними (через запятую; пусто — любые)</label>
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
              Вопрос Jev о каждом сообщении (по-английски — так Jev точнее; `message` — текст, `picture` — что на фото, `group` — тема и правила группы)
              {draft.jevPrompt?.trim() ? <button type="button" className="btn btn--sm btn--ghost" onClick={() => set({ jevPrompt: '' })}>вернуть стандартный</button> : null}
            </label>
            <textarea rows={4} value={draft.jevPrompt || HELPER_DEFAULT_JEV[kind]} onChange={(e) => set({ jevPrompt: e.target.value === HELPER_DEFAULT_JEV[kind] ? '' : e.target.value })} />
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Как готовится ответ</h2>
        <div className="groups-scenarios groups-scenarios--two">
          <button type="button" className={`groups-scenario${draft.mode !== 'model' ? ' groups-scenario--active' : ''}`} onClick={() => set({ mode: 'agent' })}>
            <b>Агент через OpenCode</b>
            <span>Главный агент пишет ответ с инструментами и умениями; помощники могут сначала поработать над запросом — их результаты он получит.</span>
          </button>
          <button type="button" className={`groups-scenario${draft.mode === 'model' ? ' groups-scenario--active' : ''}`} onClick={() => set({ mode: 'model' })}>
            <b>Сразу модель</b>
            <span>Один запрос к выбранной модели (например, бесплатной) — что она выдала, то и уходит в группу. Быстро и дёшево.</span>
          </button>
        </div>
        {draft.mode !== 'model' && (
          <>
            <div className="field">
              <label>Главный агент — пишет ответ (правится в «Агентах»)</label>
              <select value={draft.agent ?? ''} onChange={(e) => set({ agent: e.target.value || undefined })}>
                <option value="">по умолчанию — {HELPER_KINDS[kind].agent}</option>
                {agents.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.description.slice(0, 60)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Помощники — работают над запросом до главного агента, параллельно</label>
              {chips(agents.filter((a) => a.name !== mainAgent).map((a) => ({ key: a.name, label: a.name, title: a.description })), draft.helpers, (v) => set({ helpers: v }))}
            </div>
          </>
        )}
        <div className="field">
          <label>{draft.mode === 'model' ? 'Модель, которая отвечает' : 'Модель главного агента'} (при сбое — следующая по маршрутизации)</label>
          <ModelSelect value={draft.model ?? ''} models={draft.mode === 'model' ? models : models.filter((m) => m.tools)} empty="авто — выбирает маршрутизатор под задачу" onChange={(v) => set({ model: v || undefined })} />
        </div>
        <div className="field-row">
          <div className="field">
            <label>Проверка ответа второй моделью</label>
            <select value={draft.verify ?? 'agent'} onChange={(e) => set({ verify: e.target.value as HelperScenarioDef['verify'] })}>
              <option value="agent">как в настройках агента</option>
              <option value="always">всегда</option>
              <option value="free">только работу бесплатных моделей</option>
              <option value="off">не проверять</option>
            </select>
          </div>
          <div className="field">
            <label>Проверяющий</label>
            <ModelSelect value={draft.verifier ?? ''} models={models} empty="по умолчанию" onChange={(v) => set({ verifier: v || undefined })} />
          </div>
        </div>
        <div className="field">
          <label>Базы знаний — ответ опирается на найденные в них фрагменты</label>
          {chips(bases.map((b) => ({ key: b.id, label: b.name, title: b.description })), draft.knowledge, (v) => set({ knowledge: v }))}
          {!!draft.knowledge?.length && (
            <label className="groups-inline"><input type="checkbox" checked={!!draft.knowledgeOnly} onChange={(e) => set({ knowledgeOnly: e.target.checked })} /> отвечать только по материалам (если в них нет — так и сказать)</label>
          )}
        </div>
        <div className="field">
          <label>Умения, которые агент получает с каждым запросом (правятся в «Умениях»)</label>
          {chips(skills.map((x) => ({ key: x.name, label: x.name, title: x.description })), draft.skills, (v) => set({ skills: v }))}
        </div>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Что пишет помощник</h2>
        {(['ack', 'fail', 'limit'] as const).map((key) => (
          <div className="field" key={key}>
            <label>{key === 'ack' ? 'Когда взял запрос (только от имени группы; удаляется с приходом ответа)' : key === 'fail' ? 'Если не получилось' : 'Когда лимит на сегодня исчерпан ({cap} — число)'}</label>
            <input value={draft.texts?.[key] ?? ''} placeholder={HELPER_DEFAULT_TEXTS[kind][key]} onChange={(e) => set({ texts: { ...draft.texts, [key]: e.target.value } })} />
          </div>
        ))}
      </section>

      <Sandbox scenario={draft} groups={groups} />
    </div>
  );
}

function ModelSelect({ value, models, empty, onChange }: { value: string; models: AiModel[]; empty: string; onChange: (v: string) => void }) {
  const groups = new Map<string, AiModel[]>();
  for (const m of models) groups.set(m.providerID, [...(groups.get(m.providerID) ?? []), m]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{empty}</option>
      {[...groups.entries()].map(([pid, list]) => (
        <optgroup key={pid} label={pid}>
          {list.map((m) => <option key={m.ref} value={m.ref}>{m.free ? '★ ' : ''}{m.name}{m.vision ? ' · зрение' : ''}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

// A knowledge base: its documents (files, pages, pasted text), indexing progress and a search check
function KnowledgeEditor({ base, onBases, onRemoved }: { base: KnowledgeBase; onBases: (b: KnowledgeBase[]) => void; onRemoved: () => void }) {
  const api = getApi();
  const toast = useToast();
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : String(e));
  const [docs, setDocs] = useState<KnowledgeDoc[]>([]);
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [url, setUrl] = useState('');
  const [paste, setPaste] = useState({ title: '', text: '' });
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.knowledge.docs(base.id).then(setDocs, () => {});
    api.knowledge.bases().then(onBases, () => {});
  }, [api, base.id, onBases]);
  useEffect(() => {
    setName(base.name);
    setDescription(base.description);
    setHits(null);
    api.knowledge.docs(base.id).then(setDocs, () => {});
  }, [api, base.id, base.name, base.description]);
  useEffect(() => {
    if (!docs.some((d) => d.status === 'indexing')) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [docs, load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="groups-editor">
      <section className="settings-card">
        <div className="settings-card__head">
          <h2 className="settings-card__title">База знаний</h2>
          <span className="crm-muted">{base.docs} документов · {base.chunks} фрагментов</span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Удалить базу «${base.name}» со всеми документами?`) && api.knowledge.removeBase(base.id).then((l) => { onBases(l); onRemoved(); }, fail)}>Удалить</button>
        </div>
        <div className="field">
          <label>Название</label>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== base.name && api.knowledge.updateBase(base.id, { name }).then(onBases, fail)} />
        </div>
        <div className="field">
          <label>Что в ней</label>
          <input value={description} placeholder="Например: справка Яндекс Директа и наши методички" onChange={(e) => setDescription(e.target.value)} onBlur={() => description !== base.description && api.knowledge.updateBase(base.id, { description }).then(onBases, fail)} />
        </div>
        <p className="field-hint">
          Материалы разбиваются на фрагменты по заголовкам и абзацам; поиск находит подходящие и по словам, и по смыслу (локальная модель,
          ничего не уходит наружу). Помощник получает 6 лучших фрагментов к каждому вопросу.
        </p>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Добавить материалы</h2>
        <div className="helper-chat__opts">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(() => api.knowledge.addFiles(base.id))}>Файлы… (.md, .txt, .html, .pdf)</button>
        </div>
        <div className="groups-add">
          <input className="text-input" value={url} placeholder="https://… — статья, страница документации" onChange={(e) => setUrl(e.target.value)} />
          <button type="button" className="btn btn--sm" disabled={busy || !url.trim()} onClick={() => act(async () => { await api.knowledge.addUrl(base.id, url); setUrl(''); })}>Добавить страницу</button>
        </div>
        <details className="ai-engine__add">
          <summary>Вставить текст</summary>
          <div className="ai-engine__form">
            <input placeholder="Название" value={paste.title} onChange={(e) => setPaste({ ...paste, title: e.target.value })} />
            <textarea rows={5} placeholder="Текст или Markdown" value={paste.text} onChange={(e) => setPaste({ ...paste, text: e.target.value })} />
            <button type="button" className="btn btn--sm btn--primary" disabled={busy || !paste.text.trim()} onClick={() => act(async () => { await api.knowledge.addText(base.id, paste.title, paste.text); setPaste({ title: '', text: '' }); })}>Добавить</button>
          </div>
        </details>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Документы</h2>
        <ul className="ai-providers">
          {docs.map((d) => (
            <li key={d.id}>
              <span className={`status-dot${d.status === 'ready' ? ' status-dot--ok' : d.status === 'failed' ? ' status-dot--err' : ''}`} />
              <span className="ai-models__name">{d.title}</span>
              <span className="crm-muted ai-providers__url" title={d.source}>{d.source}</span>
              <span className="crm-muted">{d.status === 'indexing' ? `индексируется ${d.embedded}/${d.chunks}` : `${d.chunks} фрагм.`}</span>
              {d.error && <span className="tag tag--warn" title={d.error}>ошибка</span>}
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Убрать «${d.title}»?`) && act(() => api.knowledge.removeDoc(d.id))}>×</button>
            </li>
          ))}
          {!docs.length && <li className="crm-muted">Документов пока нет</li>}
        </ul>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Проверить поиск</h2>
        <div className="route-check">
          <input className="text-input" value={query} placeholder="Вопрос, как его задал бы участник" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && query.trim() && api.knowledge.search([base.id], query).then(setHits, fail)} />
          <button type="button" className="btn btn--sm" disabled={!query.trim()} onClick={() => api.knowledge.search([base.id], query).then(setHits, fail)}>Найти</button>
        </div>
        {hits && (
          <ol className="kb-hits">
            {hits.map((h, i) => (
              <li key={i}>
                <b>{h.docTitle}</b>{h.heading ? <span className="crm-muted"> — {h.heading}</span> : null}
                <p>{h.text.slice(0, 400)}{h.text.length > 400 ? '…' : ''}</p>
              </li>
            ))}
            {!hits.length && <li className="crm-muted">Ничего не нашлось</li>}
          </ol>
        )}
      </section>
    </div>
  );
}

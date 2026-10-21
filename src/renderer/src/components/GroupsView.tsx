import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  HELPER_DEFAULT_JEV,
  HELPER_DEFAULT_TEXTS,
  HELPER_SCENARIOS,
  type Account,
  type AgentDef,
  type AiModel,
  type KnowledgeBase,
  type KnowledgeDoc,
  type KnowledgeHit,
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
  const [models, setModels] = useState<AiModel[]>([]);
  const [bases, setBases] = useState<KnowledgeBase[]>([]);
  const [baseId, setBaseId] = useState<number | null>(null); // a knowledge base open on the right instead of a group
  const [newBase, setNewBase] = useState('');
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
    api.ai.models().then((v) => setModels(v.models), () => {});
    api.knowledge.bases().then(setBases, () => {});
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
        {draft && baseId == null && <button type="button" className="btn btn--primary btn--sm" disabled={!dirty} onClick={save}>{dirty ? 'Сохранить' : 'Сохранено'}</button>}
      </div>
      <p className="field-hint">
        Агент работает в ваших группах и обсуждениях каналов: отбирает сообщения, на которые нужно ответить, и отвечает реплаем — по сценарию группы.
        Описание групп, правила и тексты хранятся только на этом компьютере.
      </p>
      <div className="groups-layout">
        <aside className="groups-list">
          {chats.map((c) => (
            <button key={c.chatId} type="button" className={`groups-list__item${c.chatId === selected && baseId == null ? ' groups-list__item--active' : ''}`} onClick={() => { setSelected(c.chatId); setBaseId(null); }}>
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
          <div className="groups-common">
            <h2 className="section-title">Базы знаний</h2>
            {bases.map((b) => (
              <button key={b.id} type="button" className={`groups-list__item${baseId === b.id ? ' groups-list__item--active' : ''}`} onClick={() => setBaseId(b.id)}>
                <span className="status-dot status-dot--ok" />
                <span className="groups-list__name">{b.name}</span>
                <span className="crm-muted">{b.docs} док. · {b.chunks} фрагм.</span>
              </button>
            ))}
            <div className="groups-add">
              <input className="text-input" value={newBase} placeholder="Новая база: книги, справка…" onChange={(e) => setNewBase(e.target.value)} />
              <button type="button" className="btn btn--sm" disabled={!newBase.trim()} onClick={() => api.knowledge.createBase(newBase, '').then((list) => { setBases(list); setNewBase(''); setBaseId(list.find((b) => b.name === newBase.trim())?.id ?? null); }, fail)}>Создать</button>
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
        {baseId != null && bases.some((b) => b.id === baseId) ? (
          <KnowledgeEditor base={bases.find((b) => b.id === baseId)!} onBases={setBases} onRemoved={() => setBaseId(null)} />
        ) : draft ? (
          <GroupEditor draft={draft} setDraft={setDraft} accounts={accounts} agents={agents} skills={skills} models={models} bases={bases} onRemove={() => remove(draft)} />
        ) : (
          <div className="empty-state">Подключите группу или канал по ссылке слева</div>
        )}
      </div>
    </div>
  );
}

function GroupEditor({ draft, setDraft, accounts, agents, skills, models, bases, onRemove }: {
  draft: HelperChat;
  setDraft: (c: HelperChat) => void;
  accounts: Account[];
  agents: AgentDef[];
  skills: SkillDef[];
  models: AiModel[];
  bases: KnowledgeBase[];
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
  const [preview, setPreview] = useState<{ answer: string; ms: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const runPreview = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      setPreview(await api.helper.preview(draft, probe));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };
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
                <option value="">по сценарию — {HELPER_SCENARIOS[scenario].agent}</option>
                {agents.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.description.slice(0, 60)}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Помощники — работают над запросом до главного агента, параллельно</label>
              <div className="needs-row">
                {agents.filter((a) => a.name !== (draft.agent || HELPER_SCENARIOS[scenario].agent)).map((a) => {
                  const on = (draft.helpers ?? []).includes(a.name);
                  return (
                    <label key={a.name} className={`chip-check${on ? ' chip-check--on' : ''}`} title={a.description}>
                      <input type="checkbox" checked={on} onChange={(e) => set({ helpers: e.target.checked ? [...(draft.helpers ?? []), a.name] : (draft.helpers ?? []).filter((x) => x !== a.name) })} />
                      {a.name}
                    </label>
                  );
                })}
              </div>
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
            <select value={draft.verify ?? 'agent'} onChange={(e) => set({ verify: e.target.value as HelperChat['verify'] })}>
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
          <label>Базы знаний — ответ опирается на найденные в них фрагменты (создаются слева)</label>
          <div className="needs-row">
            {bases.map((b) => {
              const on = (draft.knowledge ?? []).includes(b.id);
              return (
                <label key={b.id} className={`chip-check${on ? ' chip-check--on' : ''}`} title={b.description}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ knowledge: e.target.checked ? [...(draft.knowledge ?? []), b.id] : (draft.knowledge ?? []).filter((x) => x !== b.id) })} />
                  {b.name}
                </label>
              );
            })}
            {!bases.length && <span className="crm-muted">баз пока нет</span>}
          </div>
          {!!draft.knowledge?.length && (
            <label className="groups-inline"><input type="checkbox" checked={!!draft.knowledgeOnly} onChange={(e) => set({ knowledgeOnly: e.target.checked })} /> отвечать только по материалам (если в них нет — так и сказать)</label>
          )}
        </div>
        <div className="field">
          <label>Умения, которые агент получает с каждым запросом (правятся в «Умениях»)</label>
          <div className="needs-row">
            {skills.map((sk) => {
              const on = (draft.skills ?? []).includes(sk.name);
              return (
                <label key={sk.name} className={`chip-check${on ? ' chip-check--on' : ''}`} title={sk.description}>
                  <input type="checkbox" checked={on} onChange={(e) => set({ skills: e.target.checked ? [...(draft.skills ?? []), sk.name] : (draft.skills ?? []).filter((x) => x !== sk.name) })} />
                  {sk.name}
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
        <p className="field-hint">С текущими (даже не сохранёнными) настройками: «Проверить» — что скажут фильтры и Jev; «Показать ответ» — что ответил бы помощник целиком (знания, агенты или модель, проверка). В группу ничего не уходит.</p>
        <div className="route-check">
          <textarea className="text-input" rows={2} value={probe} placeholder="Например: помогите решить №5, не понимаю как" onChange={(e) => setProbe(e.target.value)} />
          <div className="helper-chat__opts">
            <button type="button" className="btn btn--sm" disabled={testing || !probe.trim()} onClick={test}>{testing ? 'Jev думает…' : 'Проверить'}</button>
            <button type="button" className="btn btn--sm" disabled={previewing || !probe.trim()} onClick={runPreview}>{previewing ? 'Готовит ответ…' : 'Показать ответ'}</button>
          </div>
        </div>
        {verdict && (
          <p className={`groups-verdict${verdict.answer ? ' groups-verdict--yes' : ''}`}>
            {verdict.answer ? 'Ответит' : 'Не ответит'} — {verdict.reason}
          </p>
        )}
        {preview && (
          <div className="helper-log__detail">
            <div className="crm-muted">ответ за {Math.round(preview.ms / 1000)} с</div>
            <pre>{preview.answer}</pre>
          </div>
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

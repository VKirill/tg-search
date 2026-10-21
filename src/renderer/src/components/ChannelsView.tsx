import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_SLOT_KINDS,
  CHANNEL_SOURCE_KINDS,
  type Account,
  channelCategoryName,
  type ChannelAudience,
  type ChannelCalendarEntry,
  type ChannelCategory,
  type ChannelDesk,
  type ChannelFeedStats,
  type ChannelItem,
  type ChannelPost,
  type ChannelSlotKind,
  type ChannelSource,
  type ChannelSourceKind,
  type ChannelStory,
} from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const ITEM_KIND: Record<string, string> = { news: 'новость', deal: 'акция', event: 'событие' };
const POST_STATUS: Record<ChannelPost['status'], string> = { draft: 'черновик', published: 'опубликован', rejected: 'отклонён', failed: 'ошибка' };
type ItemFilter = ChannelItem['status'];
const CAL_STATE: Record<ChannelCalendarEntry['state'], string> = {
  planned: 'по расписанию', draft: 'черновик', scheduled: 'выйдет сам', published: 'вышел', rejected: 'отклонён', failed: 'ошибка', missed: 'пропущен',
};
const dayTitle = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86400_000);
  const name = diff === 0 ? 'Сегодня' : diff === 1 ? 'Завтра' : diff === -1 ? 'Вчера' : d.toLocaleDateString('ru-RU', { weekday: 'long' });
  return `${name[0].toUpperCase()}${name.slice(1)}, ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
};
const hhmm = (at: number) => new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

// «Помощник каналов»: a news desk for the owner's channel — sources collected non-stop, Jev keeps what fits, the editor
// writes posts at the scheduled times (published or left as drafts for approval)
export function ChannelsView() {
  const toast = useToast();
  const api = getApi();
  const [desks, setDesks] = useState<ChannelDesk[]>([]);
  const [pick, setPick] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [link, setLink] = useState('');
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState({ title: '', description: '', username: '' });
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  useEffect(() => {
    api.channels.desks().then((list) => {
      setDesks(list);
      setPick((p) => p ?? list[0]?.id ?? null);
    }, fail);
    api.accounts.list().then((list) => setAccounts(list.filter((a) => a.status === 'authorized')), () => {});
  }, [api, fail]);

  const add = async () => {
    const account = accounts[0];
    if (!account || !link.trim()) return;
    try {
      const d = await api.channels.createDesk(account.id, link);
      setDesks(await api.channels.desks());
      setPick(d.id);
      setLink('');
    } catch (e) {
      fail(e);
    }
  };
  const create = async () => {
    const account = accounts[0];
    if (!account) return;
    setCreating(true);
    try {
      const d = await api.channels.createChannel(account.id, { ...fresh, username: fresh.username.trim() || undefined });
      setDesks(await api.channels.desks());
      setPick(d.id);
      setFresh({ title: '', description: '', username: '' });
    } catch (e) {
      fail(e);
    } finally {
      setCreating(false);
    }
  };
  const desk = desks.find((d) => d.id === pick);

  return (
    <div className="page-view groups-view">
      <div className="page-view__head">
        <h1>Помощник каналов</h1>
      </div>
      <p className="field-hint">
        Помощник ведёт ваш канал: без перерыва собирает материалы из источников — Telegram-каналов и групп, RSS, страниц сайтов, поиска в
        интернете, страниц Facebook и Instagram во встроенном браузере с вашим входом. Jev оставляет то, что подходит каналу, и отличает
        новости от акций и событий. В заданное время редактор пишет пост на языке канала со ссылками на источники — сразу в канал или черновиком
        на одобрение. Аккаунт должен быть администратором канала.
      </p>
      <div className="groups-layout">
        <aside className="groups-list">
          <h2 className="section-title">Каналы</h2>
          {desks.map((d) => (
            <button key={d.id} type="button" className={`groups-list__item${pick === d.id ? ' groups-list__item--active' : ''}`} onClick={() => setPick(d.id)}>
              <span className={`status-dot${d.enabled ? ' status-dot--ok' : ''}`} />
              <span className="groups-list__name">{d.title}</span>
              <span className="crm-muted">{d.autopublish ? 'публикует сам' : 'черновики'} · {d.slots.map((s) => s.time).join(', ') || 'без расписания'}</span>
            </button>
          ))}
          {!desks.length && <p className="crm-muted">Каналов пока нет</p>}
          <div className="groups-add">
            <input className="text-input" value={link} placeholder="t.me/канал" onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
            <button type="button" className="btn btn--sm" disabled={!accounts.length || !link.trim()} onClick={add}>Подключить</button>
          </div>
          <details className="groups-common">
            <summary>Создать новый канал</summary>
            <div className="ai-engine__form">
              <input className="text-input" value={fresh.title} placeholder="Название" onChange={(e) => setFresh({ ...fresh, title: e.target.value })} />
              <textarea rows={3} value={fresh.description} placeholder="Описание (до 255 символов)" maxLength={255} onChange={(e) => setFresh({ ...fresh, description: e.target.value })} />
              <input className="text-input" value={fresh.username} placeholder="Публичная ссылка, латиницей (для рекламы нужна)" onChange={(e) => setFresh({ ...fresh, username: e.target.value })} />
              <button type="button" className="btn btn--sm btn--primary" disabled={!accounts.length || !fresh.title.trim() || creating} onClick={create}>{creating ? 'Создаю…' : 'Создать и подключить'}</button>
              <p className="field-hint">Канал создаётся от аккаунта {accounts[0]?.username ? `@${accounts[0].username}` : ''} — он станет владельцем.</p>
            </div>
          </details>
        </aside>
        {desk ? (
          <DeskEditor
            key={desk.id}
            desk={desk}
            accounts={accounts}
            onSaved={setDesks}
            onRemoved={(list) => {
              setDesks(list);
              setPick(list[0]?.id ?? null);
            }}
            fail={fail}
          />
        ) : (
          <div className="groups-editor"><p className="crm-muted">Подключите канал: укажите ссылку и нажмите «Подключить».</p></div>
        )}
      </div>
    </div>
  );
}

function DeskEditor({ desk, accounts, onSaved, onRemoved, fail }: {
  desk: ChannelDesk;
  accounts: Account[];
  onSaved: (list: ChannelDesk[]) => void;
  onRemoved: (list: ChannelDesk[]) => void;
  fail: (e: unknown) => void;
}) {
  const api = getApi();
  const toast = useToast();
  const [d, setD] = useState(desk);
  const [dirty, setDirty] = useState(false);
  const [sources, setSources] = useState<ChannelSource[]>([]);
  const [stories, setStories] = useState<ChannelStory[]>([]);
  const [stats, setStats] = useState<ChannelFeedStats | null>(null);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [calendar, setCalendar] = useState<ChannelCalendarEntry[]>([]);
  const [filter, setFilter] = useState<ItemFilter>('new');
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState('');

  const reload = useCallback(async () => {
    const [s, st, f, p, c] = await Promise.all([
      api.channels.sources(desk.id), api.channels.stories(desk.id, filter, 200), api.channels.feedStats(desk.id, 1), api.channels.posts(desk.id, 30),
      api.channels.calendar(desk.id, -1, 6),
    ]);
    setSources(s);
    setStories(st);
    setStats(f);
    setPosts(p);
    setCalendar(c);
  }, [api, desk.id, filter]);

  useEffect(() => {
    reload().catch(fail);
    const t = setInterval(() => void reload().catch(() => {}), 30_000);
    return () => clearInterval(t);
  }, [reload, fail]);

  const patch = (p: Partial<ChannelDesk>) => {
    setD({ ...d, ...p });
    setDirty(true);
  };
  const save = () => api.channels.saveDesk(d).then((list) => {
    onSaved(list);
    setDirty(false);
    toast('Сохранено');
  }, fail);
  const busyRun = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await fn();
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy('');
    }
  };
  const compose = (kind: ChannelSlotKind, itemIds?: number[]) => busyRun('compose', async () => {
    await api.channels.compose(d.id, kind, itemIds);
    setChosen([]);
  });


  return (
    <div className="groups-editor">
      <section className="settings-card">
        <h2 className="section-title">Основное</h2>
        <div className="helper-chat__opts">
          <label><input type="checkbox" checked={d.enabled} onChange={(e) => patch({ enabled: e.target.checked })} /> работает</label>
          <label><input type="checkbox" checked={d.autopublish} onChange={(e) => patch({ autopublish: e.target.checked })} /> публиковать сам, без одобрения</label>
        </div>
        <div className="groups-inline">
          <label>Аккаунт
            <select value={d.accountId} onChange={(e) => patch({ accountId: Number(e.target.value) })}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.username ? `@${a.username}` : a.phone}</option>)}
            </select>
          </label>
          <label>Язык постов <input className="text-input" value={d.language} onChange={(e) => patch({ language: e.target.value })} /></label>
          <label>Порог Jev <input className="text-input" type="number" min={0} max={1} step={0.05} value={d.threshold} onChange={(e) => patch({ threshold: Number(e.target.value) })} /></label>
          <label>Ссылки в постах
            <select value={d.links} onChange={(e) => patch({ links: e.target.value as ChannelDesk['links'] })}>
              <option value="none">без ссылок — свои материалы</option>
              <option value="sources">ссылки на источники</option>
            </select>
          </label>
        </div>
        <p className="field-hint">
          {d.links === 'none'
            ? 'Посты — собственные материалы канала: без ссылок и упоминаний источников, чужих каналов, сайтов и соцсетей; всё нужное — адрес, даты, цены — в самом тексте.'
            : 'В конце каждого пункта — ссылка на источник.'}
        </p>
        <div className="field">
          <label>География</label>
          <input className="text-input" value={d.area} placeholder="Например: город и его пригороды" onChange={(e) => patch({ area: e.target.value })} />
          <p className="field-hint">Jev отдельно проверяет, что сюжет происходит здесь; остальное отсеивается. Пусто — без проверки.</p>
        </div>
        <div className="field">
          <label>О канале и аудитории</label>
          <textarea rows={3} value={d.about} placeholder="Город, темы, для кого: например, новости, акции и события Валенсии для жителей" onChange={(e) => patch({ about: e.target.value })} />
          <p className="field-hint">По этому описанию Jev решает, что подходит каналу, а редактор — о чём и для кого писать.</p>
        </div>
        <div className="field">
          <label>Редактор: стиль и правила</label>
          <textarea rows={6} value={d.editorPrompt} onChange={(e) => patch({ editorPrompt: e.target.value })} />
        </div>
        <div className="field">
          <label>Расписание постов</label>
          {d.slots.map((s, i) => (
            <div key={i} className="groups-inline">
              <input className="text-input" type="time" value={s.time} onChange={(e) => patch({ slots: d.slots.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)) })} />
              <select value={s.kind} onChange={(e) => patch({ slots: d.slots.map((x, j) => (j === i ? { ...x, kind: e.target.value as ChannelSlotKind } : x)) })}>
                {Object.entries(CHANNEL_SLOT_KINDS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
              <RubricPicker categories={d.categories} value={s.categories ?? []} onChange={(v) => patch({ slots: d.slots.map((x, j) => (j === i ? { ...x, categories: v } : x)) })} />
              <AudiencePicker audiences={d.audiences} value={s.audiences ?? []} onChange={(v) => patch({ slots: d.slots.map((x, j) => (j === i ? { ...x, audiences: v } : x)) })} />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => patch({ slots: d.slots.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn--sm" onClick={() => patch({ slots: [...d.slots, { time: '13:00', kind: 'top' }] })}>+ Время</button>
          <p className="field-hint">Рубрики и аудитории у времени — подборка только из них (например, вечером «Куда сходить вечером», в пятницу «С детьми» на выходные). Без них — по виду поста.</p>
        </div>
        <Rubrics categories={d.categories} onChange={(categories) => patch({ categories })} />
        <Audiences audiences={d.audiences} onChange={(audiences) => patch({ audiences })} />
        <div className="channel-row">
          <button type="button" className="btn btn--sm btn--primary" disabled={!dirty} onClick={save}>Сохранить</button>
          <button type="button" className="btn btn--sm" disabled={dirty || !!busy} title="После смены описания, географии или рубрик" onClick={() => busyRun('rescore', async () => toast(`Пересортировано материалов: ${await api.channels.rescore(d.id)}`))}>
            {busy === 'rescore' ? 'Сортирую…' : 'Пересортировать свежие'}
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Отключить канал «${d.title}»? Источники, материалы и посты будут удалены.`) && api.channels.removeDesk(d.id).then(onRemoved, fail)}>Отключить канал</button>
        </div>
      </section>

      <Calendar
        entries={calendar}
        busy={busy}
        onPrepare={(e) => e.slot && e.slotKey && busyRun('compose', () => api.channels.compose(d.id, e.slot!.kind, undefined, { categories: e.slot!.categories, audiences: e.slot!.audiences, slotKey: e.slotKey! }))}
      />

      <Sources desk={d} sources={sources} setSources={setSources} busy={busy} busyRun={busyRun} fail={fail} />

      <Feed
        desk={d}
        stats={stats}
        stories={stories}
        filter={filter}
        setFilter={setFilter}
        chosen={chosen}
        setChosen={setChosen}
        busy={busy}
        onCompose={() => compose('digest', chosen)}
        onStatus={(id, status) => api.channels.setStoryStatus(id, status).then(reload, fail)}
      />

      <section className="settings-card">
        <h2 className="section-title">Посты</h2>
        <div className="channel-row">
          {Object.entries(CHANNEL_SLOT_KINDS).map(([k, label]) => (
            <button key={k} type="button" className="btn btn--sm" disabled={!!busy} onClick={() => compose(k as ChannelSlotKind)}>{busy === 'compose' ? 'Пишу…' : label}</button>
          ))}
        </div>
        <p className="field-hint">Кнопки пишут черновик сейчас из лучших свежих материалов. По расписанию это происходит само.</p>
        {posts.map((p) => <PostCard key={p.id} post={p} reload={reload} fail={fail} />)}
        {!posts.length && <p className="crm-muted">Постов пока нет</p>}
      </section>
    </div>
  );
}

function Sources({ desk, sources, setSources, busy, busyRun, fail }: {
  desk: ChannelDesk;
  sources: ChannelSource[];
  setSources: (s: ChannelSource[]) => void;
  busy: string;
  busyRun: (what: string, fn: () => Promise<unknown>) => Promise<void>;
  fail: (e: unknown) => void;
}) {
  const api = getApi();
  const toast = useToast();
  const [kind, setKind] = useState<ChannelSourceKind>('telegram');
  const [target, setTarget] = useState('');
  const [title, setTitle] = useState('');
  const [found, setFound] = useState<{ title: string; username: string | null; members: number | null }[]>([]);

  const addSource = (k: ChannelSourceKind, t: string, name = '') => api.channels.saveSource({
    deskId: desk.id, kind: k, title: name || t, target: t, enabled: true, intervalMin: CHANNEL_SOURCE_KINDS[k].interval,
  }).then((list) => {
    setSources(list);
    setTarget('');
    setTitle('');
  }, fail);

  return (
    <section className="settings-card">
      <h2 className="section-title">Источники</h2>
      <ul className="channel-sources">
        {sources.map((s) => (
          <li key={s.id}>
            <input type="checkbox" checked={s.enabled} title="Читать" onChange={(e) => api.channels.saveSource({ ...s, enabled: e.target.checked }).then(setSources, fail)} />
            <span className="tag">{CHANNEL_SOURCE_KINDS[s.kind].label}</span>
            <span className="channel-sources__name" title={s.target}>{s.title}</span>
            <span className={s.lastError ? 'tag tag--warn' : 'crm-muted'} title={s.lastError ?? ''}>
              {s.lastError ? 'ошибка' : s.lastRunAt ? `прочитан ${formatLeadDate(s.lastRunAt)}` : 'ещё не читался'}
            </span>
            <span className="crm-muted">найдено {s.found}</span>
            <label className="crm-muted">каждые
              <input className="text-input channel-sources__interval" type="number" min={5} value={s.intervalMin} onChange={(e) => api.channels.saveSource({ ...s, intervalMin: Number(e.target.value) }).then(setSources, fail)} /> мин
            </label>
            <button type="button" className="btn btn--sm" disabled={!!busy} onClick={() => busyRun(`src${s.id}`, async () => toast(`Новых материалов: ${await api.channels.runSource(s.id)}`))}>
              {busy === `src${s.id}` ? '…' : 'Прочитать'}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Убрать источник «${s.title}»?`) && api.channels.removeSource(s.id).then(() => api.channels.sources(desk.id)).then(setSources, fail)}>×</button>
          </li>
        ))}
        {!sources.length && <li className="crm-muted">Источников пока нет</li>}
      </ul>

      <div className="groups-inline">
        <select value={kind} onChange={(e) => setKind(e.target.value as ChannelSourceKind)}>
          {Object.entries(CHANNEL_SOURCE_KINDS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <input className="text-input" value={target} placeholder={CHANNEL_SOURCE_KINDS[kind].hint} onChange={(e) => setTarget(e.target.value)} />
        <input className="text-input" value={title} placeholder="Название (необязательно)" onChange={(e) => setTitle(e.target.value)} />
        <button type="button" className="btn btn--sm btn--primary" disabled={!target.trim()} onClick={() => addSource(kind, target.trim(), title.trim())}>Добавить</button>
        {kind === 'telegram' && (
          <button type="button" className="btn btn--sm" disabled={!target.trim()} onClick={() => api.channels.findTelegram(desk.accountId, target.trim()).then(setFound, fail)}>Найти по слову</button>
        )}
      </div>
      <p className="field-hint">{CHANNEL_SOURCE_KINDS[kind].hint}</p>
      {kind === 'browser' && (
        <div className="channel-row">
          <span className="crm-muted">Войдите один раз в отдельном окне — вход сохранится только для помощника:</span>
          <button type="button" className="btn btn--sm" onClick={() => api.channels.browserLogin('https://www.facebook.com/').catch(fail)}>Facebook</button>
          <button type="button" className="btn btn--sm" onClick={() => api.channels.browserLogin('https://www.instagram.com/').catch(fail)}>Instagram</button>
          <button type="button" className="btn btn--sm" onClick={() => api.channels.browserLogin('https://x.com/login').catch(fail)}>X (Twitter)</button>
        </div>
      )}
      {found.length > 0 && (
        <ul className="channel-sources">
          {found.map((f) => (
            <li key={f.username ?? f.title}>
              <span className="channel-sources__name">{f.title}</span>
              <span className="crm-muted">{f.username ? `@${f.username}` : ''}{f.members ? ` · ${f.members.toLocaleString('ru')} участн.` : ''}</span>
              {f.username && !sources.some((s) => s.target.replace(/^@/, '') === f.username) && (
                <button type="button" className="btn btn--sm" onClick={() => addSource('telegram', `@${f.username}`, f.title)}>Добавить</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// The publishing calendar: what went out, what waits as a draft, what each upcoming slot would be made of now
function Calendar({ entries, busy, onPrepare }: { entries: ChannelCalendarEntry[]; busy: string; onPrepare: (e: ChannelCalendarEntry) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const days = new Map<string, ChannelCalendarEntry[]>();
  for (const e of entries) {
    const k = dayTitle(e.at);
    days.set(k, [...(days.get(k) ?? []), e]);
  }
  return (
    <section className="settings-card">
      <h2 className="section-title">Календарь публикаций</h2>
      {!entries.length && <p className="crm-muted">Расписание пустое — добавьте время в «Расписании постов».</p>}
      <div className="channel-calendar">
        {[...days.entries()].map(([day, list]) => (
          <div key={day} className="channel-calendar__day">
            <h3>{day}</h3>
            {list.map((e) => {
              const id = `${e.at}-${e.post?.id ?? e.slotKey}`;
              return (
                <div key={id} className={`channel-calendar__entry channel-calendar__entry--${e.state}`}>
                  <button type="button" className="channel-calendar__line" onClick={() => setOpen(open === id ? null : id)} disabled={!e.post}>
                    <b>{hhmm(e.post?.publishedAt ?? e.post?.scheduledAt ?? e.at)}</b>
                    <span>{CHANNEL_SLOT_KINDS[e.slot?.kind ?? e.post?.kind ?? 'digest']}{e.slot ? '' : ' · вне расписания'}</span>
                    <span className={`tag${e.state === 'failed' ? ' tag--warn' : e.state === 'published' ? ' tag--soft' : ''}`}>{CAL_STATE[e.state]}</span>
                    {e.ready !== null && <span className={e.ready ? 'crm-muted' : 'tag tag--warn'}>{e.ready ? `готово сюжетов: ${e.ready}` : 'пока не из чего'}</span>}
                  </button>
                  {e.state === 'planned' && e.slot && e.ready ? (
                    <button type="button" className="btn btn--sm btn--ghost" disabled={!!busy} title="Написать сейчас, проверить и поправить — выйдет в своё время" onClick={() => onPrepare(e)}>Подготовить</button>
                  ) : null}
                  {open === id && e.post && <pre className="channel-post__text channel-calendar__text">{e.post.text}</pre>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

function AudiencePicker({ audiences, value, onChange }: { audiences: ChannelAudience[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <span className="channel-rubrics">
      {value.map((id) => (
        <span key={id} className="tag tag--soft">{audiences.find((a) => a.id === id)?.name ?? id} <button type="button" className="channel-rubrics__x" onClick={() => onChange(value.filter((v) => v !== id))}>×</button></span>
      ))}
      <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{value.length ? '+ аудитория' : 'для всех'}</option>
        {audiences.filter((a) => !value.includes(a.id)).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </span>
  );
}

// Who stories suit: across rubrics; each with a hint for Jev
function Audiences({ audiences, onChange }: { audiences: ChannelAudience[]; onChange: (a: ChannelAudience[]) => void }) {
  return (
    <details className="field channel-rubric-editor">
      <summary>Аудитории · {audiences.map((a) => a.name).join(', ') || 'нет'}</summary>
      <p className="field-hint">Сюжет может подходить нескольким аудиториям сразу — Jev отмечает каждую по её описанию. По аудиториям собираются подборки, а позже — отдельные каналы.</p>
      {audiences.map((a, i) => (
        <div key={a.id} className="groups-inline">
          <input className="text-input" value={a.name} onChange={(e) => onChange(audiences.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="text-input" value={a.hint} placeholder="кому подходит (по-английски)" onChange={(e) => onChange(audiences.map((x, j) => (j === i ? { ...x, hint: e.target.value } : x)))} />
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => onChange(audiences.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
      <button type="button" className="btn btn--sm" onClick={() => {
        const name = prompt('Название аудитории');
        if (name) onChange([...audiences, { id: `a${Date.now().toString(36)}`, name, hint: '' }]);
      }}>+ Аудитория</button>
    </details>
  );
}

// Rubric filter of a slot: chosen rubrics as tags, more from a list
function RubricPicker({ categories, value, onChange }: { categories: ChannelCategory[]; value: string[]; onChange: (v: string[]) => void }) {
  const options = categories.flatMap((c) => [c.id, ...c.subs.map((x) => `${c.id}.${x.id}`)]).filter((id) => !value.includes(id));
  return (
    <span className="channel-rubrics">
      {value.map((id) => (
        <span key={id} className="tag">{channelCategoryName(categories, id)} <button type="button" className="channel-rubrics__x" onClick={() => onChange(value.filter((v) => v !== id))}>×</button></span>
      ))}
      <select value="" onChange={(e) => e.target.value && onChange([...value, e.target.value])}>
        <option value="">{value.length ? '+ рубрика' : 'все рубрики'}</option>
        {options.map((id) => <option key={id} value={id}>{channelCategoryName(categories, id)}</option>)}
      </select>
    </span>
  );
}

// The channel's rubrics and sub-rubrics: names for people, hints for Jev
function Rubrics({ categories, onChange }: { categories: ChannelCategory[]; onChange: (c: ChannelCategory[]) => void }) {
  const set = (i: number, c: ChannelCategory) => onChange(categories.map((x, j) => (j === i ? c : x)));
  const slug = (name: string, taken: string[]) => {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'r';
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}${n}`;
    return id;
  };
  return (
    <details className="field channel-rubric-editor">
      <summary>Рубрики · {categories.length}, подрубрик {categories.reduce((n, c) => n + c.subs.length, 0)}</summary>
      <p className="field-hint">Jev относит каждый сюжет к одной подрубрике по её описанию (описания лучше писать по-английски). По рубрикам собираются отдельные подборки.</p>
      {categories.map((c, i) => (
        <div key={c.id} className="channel-rubric">
          <div className="groups-inline">
            <input className="text-input" value={c.name} onChange={(e) => set(i, { ...c, name: e.target.value })} />
            <input className="text-input" value={c.hint} placeholder="что сюда относится" onChange={(e) => set(i, { ...c, hint: e.target.value })} />
            <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Убрать рубрику «${c.name}»?`) && onChange(categories.filter((_, j) => j !== i))}>×</button>
          </div>
          {c.subs.map((sub, k) => (
            <div key={sub.id} className="groups-inline channel-rubric__sub">
              <span className="crm-muted">›</span>
              <input className="text-input" value={sub.name} onChange={(e) => set(i, { ...c, subs: c.subs.map((x, j) => (j === k ? { ...x, name: e.target.value } : x)) })} />
              <input className="text-input" value={sub.hint} placeholder="что сюда относится" onChange={(e) => set(i, { ...c, subs: c.subs.map((x, j) => (j === k ? { ...x, hint: e.target.value } : x)) })} />
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => set(i, { ...c, subs: c.subs.filter((_, j) => j !== k) })}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn--sm btn--ghost channel-rubric__sub" onClick={() => {
            const name = prompt('Название подрубрики');
            if (name) set(i, { ...c, subs: [...c.subs, { id: slug(`s${c.subs.length + 1}`, c.subs.map((x) => x.id)), name, hint: '' }] });
          }}>+ подрубрика</button>
        </div>
      ))}
      <button type="button" className="btn btn--sm" onClick={() => {
        const name = prompt('Название рубрики');
        if (name) onChange([...categories, { id: slug(`r${categories.length + 1}`, categories.map((x) => x.id)), name, hint: '', subs: [] }]);
      }}>+ Рубрика</button>
    </details>
  );
}

// What the sources brought: stories (one story — however many sources told it), repeats, what fits, by rubric
function Feed({ desk, stats, stories, filter, setFilter, chosen, setChosen, busy, onCompose, onStatus }: {
  desk: ChannelDesk;
  stats: ChannelFeedStats | null;
  stories: ChannelStory[];
  filter: ItemFilter;
  setFilter: (f: ItemFilter) => void;
  chosen: number[];
  setChosen: (ids: number[]) => void;
  busy: string;
  onCompose: () => void;
  onStatus: (storyId: number, status: ChannelItem['status']) => void;
}) {
  const [rubric, setRubric] = useState('');
  const [audience, setAudience] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const shown = stories
    .filter((st) => !rubric || st.category === rubric || st.category?.startsWith(`${rubric}.`))
    .filter((st) => !audience || st.audiences.includes(audience));
  const rubricCount = (id: string) => Object.entries(stats?.byCategory ?? {}).reduce((n, [k, v]) => n + (k === id || k.startsWith(`${id}.`) ? v : 0), 0);
  return (
    <section className="settings-card">
      <h2 className="section-title">Лента</h2>
      {stats && (
        <div className="channel-stats">
          <div><b>{stats.items}</b><span>материалов за сутки</span></div>
          <div><b>{stats.stories}</b><span>разных сюжетов</span></div>
          <div><b>{pct(stats.duplicates, stats.items)}</b><span>повторов</span></div>
          <div><b>{stats.kept}</b><span>сюжетов подходит</span></div>
        </div>
      )}
      {stats && stats.sources.length > 0 && (
        <details className="channel-source-stats">
          <summary>Что приносят источники за сутки</summary>
          <table>
            <thead><tr><th>Источник</th><th>Материалов</th><th>Первым</th><th>Повторы</th><th>Подходит</th></tr></thead>
            <tbody>
              {stats.sources.map((s) => (
                <tr key={s.sourceId}>
                  <td>{s.title} <span className="crm-muted">· {CHANNEL_SOURCE_KINDS[s.kind].label}</span></td>
                  <td>{s.items}</td>
                  <td title="сюжеты, которые этот источник принёс раньше других">{s.first}</td>
                  <td>{pct(s.duplicates, s.items)}</td>
                  <td>{pct(s.kept, s.items)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <div className="channel-feed__bar">
        <div className="segmented">
          {(['new', 'used', 'skipped'] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? 'button--active' : ''} onClick={() => setFilter(f)}>
              {f === 'new' ? 'Подходит' : f === 'used' ? 'В постах' : 'Отсеяно'}
            </button>
          ))}
        </div>
        {chosen.length > 0 && (
          <button type="button" className="btn btn--sm btn--primary" disabled={!!busy} onClick={onCompose}>Пост из отмеченных ({chosen.length})</button>
        )}
      </div>
      <div className="channel-feed__rubrics">
        <button type="button" className={`channel-chip${rubric === '' ? ' channel-chip--active' : ''}`} onClick={() => setRubric('')}>Все</button>
        {desk.categories.map((c) => (
          <button key={c.id} type="button" className={`channel-chip${rubric === c.id ? ' channel-chip--active' : ''}`} onClick={() => setRubric(rubric === c.id ? '' : c.id)}>
            {c.name}{filter === 'new' ? ` · ${rubricCount(c.id)}` : ''}
          </button>
        ))}
      </div>
      <div className="channel-feed__rubrics">
        <span className="crm-muted">Для кого:</span>
        {desk.audiences.map((a) => (
          <button key={a.id} type="button" className={`channel-chip${audience === a.id ? ' channel-chip--active' : ''}`} onClick={() => setAudience(audience === a.id ? '' : a.id)}>
            {a.name}{filter === 'new' ? ` · ${stats?.byAudience?.[a.id] ?? 0}` : ''}
          </button>
        ))}
      </div>
      <ul className="channel-items">
        {shown.map((st) => (
          <li key={st.id}>
            {filter === 'new' && (
              <input type="checkbox" checked={chosen.includes(st.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, st.id] : chosen.filter((x) => x !== st.id))} />
            )}
            <div className="channel-items__body">
              <div className="channel-items__title">{st.title}</div>
              <div className="channel-items__meta">
                {st.kind && <span className="tag">{ITEM_KIND[st.kind]}</span>}
                {st.category && <span className="tag tag--soft">{channelCategoryName(desk.categories, st.category)}</span>}
                {st.audiences.map((a) => <span key={a} className="tag">{desk.audiences.find((x) => x.id === a)?.name ?? a}</span>)}
                <button type="button" className="channel-items__sources" onClick={() => setOpen(open === st.id ? null : st.id)}>
                  {st.items.length > 1 ? `${st.items.length} источника` : st.items[0]?.sourceTitle}
                </button>
                <span className="crm-muted">{formatLeadDate(st.publishedAt)}</span>
                {st.score !== null && <span className="crm-muted">Jev {Math.round(st.score * 100)}%</span>}
                {st.local !== null && <span className={st.local < 0.5 ? 'tag tag--warn' : 'crm-muted'}>{st.local < 0.5 ? 'не наша география' : `здесь ${Math.round(st.local * 100)}%`}</span>}
              </div>
              {st.text && !st.text.startsWith(st.title) && <p className="channel-items__text">{st.text.slice(0, 260)}</p>}
              {open === st.id && (
                <ul className="channel-items__from">
                  {st.items.map((it) => (
                    <li key={it.id}>
                      <span className="crm-muted">{it.sourceTitle} · {formatLeadDate(it.publishedAt)}</span>{' '}
                      {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {st.status === 'new' && <button type="button" className="btn btn--sm btn--ghost" title="Не брать в посты" onClick={() => onStatus(st.id, 'skipped')}>×</button>}
            {st.status === 'skipped' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => onStatus(st.id, 'new')}>вернуть</button>}
          </li>
        ))}
        {!shown.length && <li className="crm-muted">Пусто. Сюжеты появятся, когда источники прочитаются и Jev их оценит.</li>}
      </ul>
    </section>
  );
}

function PostCard({ post, reload, fail }: { post: ChannelPost; reload: () => Promise<void>; fail: (e: unknown) => void }) {
  const api = getApi();
  const [text, setText] = useState(post.text);
  const [busy, setBusy] = useState(false);
  const editable = post.status === 'draft' || post.status === 'failed';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="channel-post">
      <div className="channel-post__head">
        <span className={`tag${post.status === 'failed' ? ' tag--warn' : ''}`}>{POST_STATUS[post.status]}</span>
        <span>{CHANNEL_SLOT_KINDS[post.kind]}</span>
        <span className="crm-muted">{formatLeadDate(post.publishedAt ?? post.createdAt)} · материалов: {post.itemIds.length}{post.image ? ' · с картинкой' : ''}</span>
        {post.status === 'draft' && post.scheduledAt && <span className="tag tag--soft">выйдет {formatLeadDate(post.scheduledAt)}</span>}
      </div>
      {post.error && <p className="crm-muted">{post.error}</p>}
      {post.status === 'published' && (
        <div className="channel-row">
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => confirm('Удалить пост из канала? Его сюжеты вернутся в работу.') && act(() => api.channels.unpublish(post.id))}>Удалить из канала</button>
        </div>
      )}
      {editable ? <textarea rows={Math.min(18, text.split('\n').length + 2)} value={text} onChange={(e) => setText(e.target.value)} /> : <pre className="channel-post__text">{post.text}</pre>}
      {editable && (
        <div className="channel-row">
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => act(async () => {
            if (text !== post.text) await api.channels.savePost(post.id, text);
            await api.channels.publish(post.id);
          })}>{busy ? 'Публикую…' : 'Опубликовать'}</button>
          {text !== post.text && <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(() => api.channels.savePost(post.id, text))}>Сохранить правки</button>}
          <input
            className="text-input channel-post__when"
            type="datetime-local"
            value={post.scheduledAt ? toLocalInput(post.scheduledAt) : ''}
            title="Выйдет само в это время"
            onChange={(e) => act(() => api.channels.schedule(post.id, e.target.value ? new Date(e.target.value).getTime() : null))}
          />
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act(() => api.channels.rejectPost(post.id))}>Отклонить</button>
        </div>
      )}
    </div>
  );
}

const toLocalInput = (at: number) => {
  const d = new Date(at - new Date(at).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

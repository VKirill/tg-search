import { useCallback, useEffect, useState } from 'react';
import {
  CHANNEL_SLOT_KINDS,
  CHANNEL_SOURCE_KINDS,
  type Account,
  type ChannelDesk,
  type ChannelItem,
  type ChannelPost,
  type ChannelSlotKind,
  type ChannelSource,
  type ChannelSourceKind,
} from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const ITEM_KIND: Record<string, string> = { news: 'новость', deal: 'акция', event: 'событие' };
const POST_STATUS: Record<ChannelPost['status'], string> = { draft: 'черновик', published: 'опубликован', rejected: 'отклонён', failed: 'ошибка' };
type ItemFilter = 'new' | 'used' | 'skipped';

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
  const [items, setItems] = useState<ChannelItem[]>([]);
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [filter, setFilter] = useState<ItemFilter>('new');
  const [chosen, setChosen] = useState<number[]>([]);
  const [busy, setBusy] = useState('');

  const reload = useCallback(async () => {
    const [s, i, p] = await Promise.all([api.channels.sources(desk.id), api.channels.items(desk.id, 300), api.channels.posts(desk.id, 30)]);
    setSources(s);
    setItems(i);
    setPosts(p);
  }, [api, desk.id]);

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

  const shown = items.filter((i) => (filter === 'new' ? i.status === 'new' && i.score !== null : i.status === filter));
  const pending = items.filter((i) => i.score === null).length;

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
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => patch({ slots: d.slots.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button type="button" className="btn btn--sm" onClick={() => patch({ slots: [...d.slots, { time: '13:00', kind: 'top' }] })}>+ Время</button>
        </div>
        <div className="helper-chat__head">
          <button type="button" className="btn btn--sm btn--primary" disabled={!dirty} onClick={save}>Сохранить</button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Отключить канал «${d.title}»? Источники, материалы и посты будут удалены.`) && api.channels.removeDesk(d.id).then(onRemoved, fail)}>Отключить канал</button>
        </div>
      </section>

      <Sources desk={d} sources={sources} setSources={setSources} busy={busy} busyRun={busyRun} fail={fail} />

      <section className="settings-card">
        <h2 className="section-title">Найденное</h2>
        <div className="helper-chat__head">
          {(['new', 'used', 'skipped'] as const).map((f) => (
            <button key={f} type="button" className={`btn btn--sm${filter === f ? ' btn--primary' : ''}`} onClick={() => setFilter(f)}>
              {f === 'new' ? 'Подходит' : f === 'used' ? 'В постах' : 'Отсеяно'} · {items.filter((i) => (f === 'new' ? i.status === 'new' && i.score !== null : i.status === f)).length}
            </button>
          ))}
          {pending > 0 && <span className="crm-muted">Jev оценивает: {pending}</span>}
          {chosen.length > 0 && (
            <button type="button" className="btn btn--sm btn--primary" disabled={!!busy} onClick={() => compose('digest', chosen)}>Пост из отмеченных ({chosen.length})</button>
          )}
        </div>
        <ul className="channel-items">
          {shown.map((it) => (
            <li key={it.id}>
              {filter === 'new' && (
                <input type="checkbox" checked={chosen.includes(it.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, it.id] : chosen.filter((x) => x !== it.id))} />
              )}
              <div className="channel-items__body">
                <div className="channel-items__title">
                  {it.kind && <span className="tag">{ITEM_KIND[it.kind]}</span>}
                  {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}
                </div>
                <div className="crm-muted">
                  {it.sourceTitle} · {formatLeadDate(it.publishedAt)}{it.score !== null ? ` · Jev ${Math.round(it.score * 100)}%` : ''}
                </div>
                {it.text && it.text !== it.title && <p className="channel-items__text">{it.text.slice(0, 280)}</p>}
              </div>
              {it.status === 'new' && <button type="button" className="btn btn--sm btn--ghost" title="Не брать в посты" onClick={() => api.channels.setItemStatus(it.id, 'skipped').then(reload, fail)}>×</button>}
              {it.status === 'skipped' && <button type="button" className="btn btn--sm btn--ghost" onClick={() => api.channels.setItemStatus(it.id, 'new').then(reload, fail)}>вернуть</button>}
            </li>
          ))}
          {!shown.length && <li className="crm-muted">Пусто. Материалы появятся, когда источники прочитаются.</li>}
        </ul>
      </section>

      <section className="settings-card">
        <h2 className="section-title">Посты</h2>
        <div className="helper-chat__head">
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
        <div className="helper-chat__head">
          <span className="crm-muted">Войдите один раз в отдельном окне — вход сохранится только для помощника:</span>
          <button type="button" className="btn btn--sm" onClick={() => api.channels.browserLogin('https://www.facebook.com/').catch(fail)}>Facebook</button>
          <button type="button" className="btn btn--sm" onClick={() => api.channels.browserLogin('https://www.instagram.com/').catch(fail)}>Instagram</button>
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
      </div>
      {post.error && <p className="crm-muted">{post.error}</p>}
      {editable ? <textarea rows={Math.min(18, text.split('\n').length + 2)} value={text} onChange={(e) => setText(e.target.value)} /> : <pre className="channel-post__text">{post.text}</pre>}
      {editable && (
        <div className="helper-chat__head">
          <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => act(async () => {
            if (text !== post.text) await api.channels.savePost(post.id, text);
            await api.channels.publish(post.id);
          })}>{busy ? 'Публикую…' : 'Опубликовать'}</button>
          {text !== post.text && <button type="button" className="btn btn--sm" disabled={busy} onClick={() => act(() => api.channels.savePost(post.id, text))}>Сохранить правки</button>}
          <button type="button" className="btn btn--sm btn--ghost" disabled={busy} onClick={() => act(() => api.channels.rejectPost(post.id))}>Отклонить</button>
        </div>
      )}
    </div>
  );
}

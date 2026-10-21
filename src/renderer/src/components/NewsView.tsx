import { useCallback, useEffect, useState } from 'react';
import type { NewsChannel, NewsItem, NewsStatus } from '../../../shared/types';
import { formatLeadDate } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { IconExternal } from './Icons';
import { LinkText } from './LinkText';
import { useToast } from './Toast';

const TABS: { id: NewsStatus | 'all'; label: string }[] = [
  { id: 'new', label: 'Новые' },
  { id: 'saved', label: 'Избранное' },
  { id: 'used', label: 'В работе' },
  { id: 'all', label: 'Все' },
];

export function NewsView() {
  const toast = useToast();
  const api = getApi();
  const [channels, setChannels] = useState<NewsChannel[]>([]);
  const [items, setItems] = useState<NewsItem[]>([]);
  const [tab, setTab] = useState<NewsStatus | 'all'>('new');
  const [interests, setInterests] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [drafting, setDrafting] = useState<number | null>(null);

  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  const load = useCallback(async () => {
    const [c, i] = await Promise.all([api.news.channels(), api.news.items(tab)]);
    setChannels(c);
    setItems(i);
  }, [api, tab]);

  useEffect(() => {
    load().catch(fail);
  }, [load, fail]);

  useEffect(() => {
    api.settings.get().then((s) => setInterests(s.newsInterests), fail);
  }, [api, fail]);

  useEffect(
    () => api.onEvent((e) => {
      if (e.type === 'news:new' && (tab === 'new' || tab === 'all')) setItems((prev) => [e.item, ...prev.filter((x) => x.id !== e.item.id)]);
    }),
    [api, tab],
  );

  const saveInterests = () => api.settings.set({ newsInterests: interests.trim() }).catch(fail);

  const addChannel = async () => {
    if (!link.trim()) return;
    try {
      const ch = await api.news.addChannel(link.trim());
      setLink('');
      toast(`«${ch.title}» добавлен — читаю последние посты`);
      await load();
    } catch (e) {
      fail(e);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const n = await api.news.runNow();
      toast(n ? `Новых интересных постов: ${n}` : 'Ничего нового');
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (item: NewsItem, status: NewsStatus) => {
    try {
      await api.news.setStatus(item.id, status);
      setItems((prev) => (tab === 'all' && status !== 'dismissed'
        ? prev.map((x) => (x.id === item.id ? { ...x, status } : x))
        : prev.filter((x) => x.id !== item.id)));
    } catch (e) {
      fail(e);
    }
  };

  const draft = async (item: NewsItem, kind: 'repost' | 'review') => {
    setDrafting(item.id);
    try {
      const text = await api.news.draft(item.id, kind);
      setDrafts((d) => ({ ...d, [item.id]: text }));
    } catch (e) {
      fail(e);
    } finally {
      setDrafting(null);
    }
  };

  return (
    <div className="page-view page-view--news">
      <div className="page-view__head">
        <h1>Новости</h1>
        <button type="button" className="btn btn--sm" onClick={refresh} disabled={busy || channels.length === 0}>
          {busy ? 'Читаю каналы…' : 'Обновить'}
        </button>
      </div>

      <div className="news-setup">
        <div className="field">
          <label>Что отслеживать</label>
          <textarea rows={2} value={interests} onChange={(e) => setInterests(e.target.value)} onBlur={saveInterests} />
        </div>
        <div className="field">
          <label>Каналы — читаются без подписки</label>
          <div className="news-add">
            <input
              value={link}
              placeholder="@channel или t.me/channel"
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addChannel()}
            />
            <button type="button" className="btn btn--sm btn--primary" onClick={addChannel}>Добавить</button>
          </div>
          <div className="chip-row">
            {channels.map((c) => (
              <span key={c.id} className={`chip${c.enabled ? '' : ' news-channel--off'}`} title={c.lastCheckedAt ? `прочитан ${formatLeadDate(c.lastCheckedAt)}` : 'ещё не читали'}>
                <button type="button" onClick={() => api.news.updateChannel(c.id, { enabled: !c.enabled }).then(load, fail)}>
                  {c.title}
                </button>
                <button type="button" aria-label="Убрать канал" onClick={() => confirm(`Убрать «${c.title}» и его посты?`) && api.news.removeChannel(c.id).then(load, fail)}>×</button>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="skills-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`filter-chip${tab === t.id ? ' filter-chip--active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {items.length === 0 ? (
        <div className="empty-state">
          {channels.length === 0 ? 'Добавьте каналы, за которыми следить.' : 'Здесь пусто. Интересные посты появятся после чтения каналов.'}
        </div>
      ) : (
        <ul className="spam-list">
          {items.map((n) => (
            <li key={n.id} className="spam-card news-card">
              <div className="spam-card__head">
                <span className="crm-muted">{n.channelTitle} · {formatLeadDate(n.date)}</span>
                <span className="score-badge" title="Насколько пост подходит под ваши интересы (Jev)">{n.score}%</span>
              </div>
              {n.summary && <p className="news-card__summary">{n.summary}</p>}
              {n.why && <p className="crm-muted news-card__why">{n.why}</p>}
              <details className="news-card__text">
                <summary>Текст поста</summary>
                <p><LinkText text={n.text} /></p>
              </details>
              <div className="spam-card__actions">
                {n.link && (
                  <button type="button" className="btn btn--sm btn--ghost" onClick={() => api.shell.openExternal(n.link!)}>
                    Открыть <IconExternal size={12} />
                  </button>
                )}
                <button type="button" className="btn btn--sm" disabled={drafting === n.id} onClick={() => draft(n, 'repost')}>Репост</button>
                <button type="button" className="btn btn--sm" disabled={drafting === n.id} onClick={() => draft(n, 'review')}>Обзор</button>
                {n.status !== 'saved' && <button type="button" className="btn btn--sm" onClick={() => setStatus(n, 'saved')}>В избранное</button>}
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => setStatus(n, 'dismissed')}>Скрыть</button>
                {drafting === n.id && <span className="crm-muted">Пишу черновик…</span>}
              </div>
              {drafts[n.id] && (
                <div className="news-card__draft">
                  <textarea rows={8} value={drafts[n.id]} onChange={(e) => setDrafts((d) => ({ ...d, [n.id]: e.target.value }))} />
                  <button type="button" className="btn btn--sm" onClick={() => navigator.clipboard.writeText(drafts[n.id]).then(() => toast('Скопировано'))}>
                    Копировать
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

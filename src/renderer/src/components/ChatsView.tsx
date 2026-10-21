// «Чаты»: manual Telegram client over the work accounts — chat list, history, search, join/leave.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Account, ChatInfo, ChatItem, ChatSummary, Project, Source } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { AudioPlayer } from './AudioPlayer';
import { IconSearch } from './Icons';
import { LinkText } from './LinkText';
import { useToast } from './Toast';

const KIND_LABEL: Record<ChatInfo['kind'], string> = {
  private: 'личный чат',
  group: 'группа',
  supergroup: 'группа',
  channel: 'канал',
};

// First letters of the first two words; emoji and symbols are skipped (w[0] would cut a surrogate pair)
function initials(title: string) {
  const words = title.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.slice(0, 2).map((w) => Array.from(w)[0].toUpperCase()).join('') || '·';
}

function hue(id: number) {
  return Math.abs(id * 47) % 360;
}

function timeLabel(ms: number | null) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function Avatar({ chat }: { chat: ChatInfo }) {
  return (
    <div className="chats-avatar" style={{ background: `hsl(${hue(chat.chatId)} 35% 38%)` }}>
      {initials(chat.title)}
    </div>
  );
}

export type ChatOpenTarget = { accountId: number; chatId: number; messageId: number | null; chat?: ChatInfo };

type Props = {
  accounts: Account[];
  projects: Project[];
  initialTarget?: ChatOpenTarget | null;
  onConsumeTarget?: () => void;
};

export function ChatsView({ accounts, projects, initialTarget, onConsumeTarget }: Props) {
  const api = getApi();
  const toast = useToast();
  const authorized = accounts.filter((a) => a.status === 'authorized');
  const [accountId, setAccountId] = useState<number | null>(authorized[0]?.id ?? null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [filter, setFilter] = useState('');
  const [found, setFound] = useState<ChatInfo[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<ChatInfo | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [noMore, setNoMore] = useState(false);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<ChatItem | null>(null);
  const [voiceUrls, setVoiceUrls] = useState<Record<number, string>>({});
  const [sources, setSources] = useState<Record<number, Source[]>>({});
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null);
  const [publicationLink, setPublicationLink] = useState<string | null>(null);
  const [discussion, setDiscussion] = useState<ChatInfo | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef<Record<number, HTMLDivElement | null>>({});

  useEffect(() => {
    if (accountId == null && authorized[0]) setAccountId(authorized[0].id);
  }, [authorized, accountId]);

  const loadChats = useCallback(async () => {
    if (accountId == null) return;
    setChats(await api.chats.list(accountId));
  }, [api, accountId]);

  useEffect(() => {
    loadChats().catch((e) => toast(e.message));
  }, [loadChats, toast]);

  const openAround = useCallback(
    async (target: ChatOpenTarget) => {
      setAccountId(target.accountId);
      setHighlightMessageId(target.messageId);
      setReplyTo(null);
      setLoadingHistory(true);
      try {
        const list = await api.chats.list(target.accountId);
        setChats(list);
        const chat =
          list.find((c) => c.chatId === target.chatId) ??
          target.chat ??
          ({
            chatId: target.chatId,
            title: `Чат ${target.chatId}`,
            username: null,
            kind: 'supergroup',
            memberCount: null,
            isMember: true,
          } as ChatSummary);
        setSelected(chat);
        setDiscussion(null);
        if (chat.kind === 'channel') api.chats.discussion(target.accountId, chat.chatId).then(setDiscussion, () => {});
        if (target.messageId == null) {
          // a link to the chat itself: its latest messages
          const latest = await api.chats.history(target.accountId, target.chatId, null);
          setItems(latest);
          setNoMore(latest.length === 0);
          requestAnimationFrame(() => timelineRef.current?.scrollTo(0, timelineRef.current.scrollHeight));
          return;
        }
        const messageId = target.messageId;
        const page = await api.chats.around(target.accountId, target.chatId, messageId);
        setItems(page);
        setNoMore(true);
        const hit = page.find((m) => m.messageId === messageId);
        setPublicationLink(hit?.link ?? null);
        requestAnimationFrame(() => {
          const el = messageRefs.current[messageId];
          if (el) {
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
          } else {
            timelineRef.current?.scrollTo(0, timelineRef.current.scrollHeight);
          }
        });
      } catch (e) {
        toast((e as Error).message);
      } finally {
        setLoadingHistory(false);
        onConsumeTarget?.();
      }
    },
    [api, loadChats, onConsumeTarget, toast],
  );

  useEffect(() => {
    if (!initialTarget) return;
    openAround(initialTarget);
  }, [initialTarget, openAround]);

  const loadSources = useCallback(async () => {
    const entries = await Promise.all(projects.map(async (p) => [p.id, await api.sources.list(p.id)] as const));
    setSources(Object.fromEntries(entries));
  }, [api, projects]);

  useEffect(() => {
    loadSources().catch(() => {});
  }, [loadSources]);

  const open = async (chat: ChatInfo) => {
    if (accountId == null) return;
    setSelected(chat);
    setItems([]);
    setNoMore(false);
    setReplyTo(null);
    setHighlightMessageId(null);
    setPublicationLink(null);
    setDiscussion(null);
    if (chat.kind === 'channel') {
      api.chats.discussion(accountId, chat.chatId).then(setDiscussion, () => setDiscussion(null));
    }
    setLoadingHistory(true);
    try {
      const page = await api.chats.history(accountId, chat.chatId, null);
      setItems(page);
      setNoMore(page.length === 0);
      requestAnimationFrame(() => timelineRef.current?.scrollTo(0, timelineRef.current.scrollHeight));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoadingHistory(false);
    }
  };

  const loadOlder = async () => {
    if (accountId == null || !selected || !items.length) return;
    setLoadingHistory(true);
    try {
      const page = await api.chats.history(accountId, selected.chatId, items[0].messageId);
      if (!page.length) setNoMore(true);
      setItems((prev) => [...page, ...prev]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setLoadingHistory(false);
    }
  };

  const search = async () => {
    const q = filter.trim();
    if (!q || accountId == null) return setFound(null);
    setSearching(true);
    try {
      setFound(await api.chats.search(accountId, q));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSearching(false);
    }
  };

  const join = async (target: number | string) => {
    if (accountId == null) return;
    try {
      const chat = await api.chats.join(accountId, target);
      toast(`Вы вступили: ${chat.title}`);
      setSelected(chat);
      setFound(null);
      setFilter('');
      await loadChats();
      await open(chat);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const leave = async () => {
    if (accountId == null || !selected) return;
    if (!confirm(`Покинуть «${selected.title}»?`)) return;
    try {
      await api.chats.leave(accountId, selected.chatId);
      toast(`Вы покинули «${selected.title}»`);
      setSelected(null);
      setItems([]);
      await loadChats();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const blockSpam = async () => {
    if (accountId == null || !selected) return;
    if (!confirm(`«${selected.title}» — спам-чат? Выйдем из него со всех аккаунтов и больше не вступим.`)) return;
    try {
      await api.spam.blockChat(accountId, selected.chatId);
      toast(`«${selected.title}» в спам-чатах`);
      setSelected(null);
      setItems([]);
      await loadChats();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const send = async () => {
    if (accountId == null || !selected || !text.trim()) return;
    try {
      const item = await api.chats.send(accountId, selected.chatId, text.trim(), replyTo?.messageId ?? null);
      setItems((prev) => [...prev, item]);
      setText('');
      setReplyTo(null);
      requestAnimationFrame(() => timelineRef.current?.scrollTo(0, timelineRef.current.scrollHeight));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const playVoice = async (item: ChatItem) => {
    if (accountId == null || !item.voice) return;
    try {
      const url = await api.chats.media(accountId, item.voice.fileId);
      setVoiceUrls((prev) => ({ ...prev, [item.messageId]: url }));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const setListening = async (projectId: number, source: Source, listen: boolean) => {
    try {
      await api.sources.setStatus(source.id, listen ? 'active' : 'rejected');
      await loadSources();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? chats.filter((c) => c.title.toLowerCase().includes(q) || (c.username ?? '').toLowerCase().includes(q)) : chats;
  }, [chats, filter]);

  if (!authorized.length) {
    return (
      <div className="page-view">
        <div className="crm-muted">Подключите рабочий аккаунт Telegram в разделе «Аккаунты».</div>
      </div>
    );
  }

  return (
    <>
      <aside className="list-column chats-list">
        <div className="list-column__head no-drag">
          <select
            className="project-switcher"
            value={accountId ?? ''}
            onChange={(e) => {
              setAccountId(Number(e.target.value));
              setSelected(null);
              setItems([]);
            }}
            aria-label="Аккаунт"
          >
            {authorized.map((a) => (
              <option key={a.id} value={a.id}>
                {[a.firstName, a.username ? `@${a.username}` : a.phone].filter(Boolean).join(' · ')}
              </option>
            ))}
          </select>
        </div>
        <div className="chats-search no-drag">
          <IconSearch size={14} />
          <input
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              if (!e.target.value) setFound(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            placeholder="Фильтр или поиск новых чатов (Enter)"
          />
        </div>
        {filter.trim() && !found && (
          <button type="button" className="chats-search-hint no-drag" onClick={search} disabled={searching}>
            {searching ? 'Ищу в Telegram…' : `Найти «${filter.trim()}» в Telegram`}
          </button>
        )}
        {/^(@|https?:\/\/|t\.me\/)/.test(filter.trim()) && (
          <button type="button" className="chats-search-hint no-drag" onClick={() => join(filter.trim())}>
            Вступить по ссылке {filter.trim()}
          </button>
        )}
        <div className="chats-items">
          {found && (
            <>
              <div className="chats-section">Найдено в Telegram · {found.length}</div>
              {found.map((c) => (
                <div key={`f${c.chatId}`} className="chats-item" onClick={() => open(c)}>
                  <Avatar chat={c} />
                  <div className="chats-item__body">
                    <div className="chats-item__title">{c.title}</div>
                    <div className="chats-item__sub">
                      {c.username ? `@${c.username} · ` : ''}
                      {KIND_LABEL[c.kind]}
                      {c.memberCount ? ` · ${c.memberCount.toLocaleString('ru-RU')}` : ''}
                    </div>
                  </div>
                  {c.spamReason ? (
                    <span className="tag tag--warn" title={c.spamReason}>спам-чат</span>
                  ) : c.isMember ? (
                    <span className="chats-badge">вы в чате</span>
                  ) : (
                    <button type="button" className="btn btn--sm btn--primary" onClick={(e) => { e.stopPropagation(); join(c.chatId); }}>
                      Вступить
                    </button>
                  )}
                </div>
              ))}
              <div className="chats-section">Мои чаты</div>
            </>
          )}
          {visible.map((c) => (
            <div
              key={c.chatId}
              className={`chats-item${selected?.chatId === c.chatId ? ' chats-item--active' : ''}`}
              onClick={() => open(c)}
            >
              <Avatar chat={c} />
              <div className="chats-item__body">
                <div className="chats-item__row">
                  <div className="chats-item__title">{c.title}</div>
                  <div className="chats-item__time">{timeLabel(c.lastDate)}</div>
                </div>
                <div className="chats-item__row">
                  <div className="chats-item__sub">{c.lastText || KIND_LABEL[c.kind]}</div>
                  {c.unreadCount > 0 && <span className="chats-unread">{c.unreadCount}</span>}
                </div>
              </div>
            </div>
          ))}
          {!visible.length && !found && <div className="crm-muted chats-empty">Чатов не найдено</div>}
        </div>
      </aside>

      <section className="chats-main">
        {!selected ? (
          <div className="chats-placeholder">Выберите чат слева или найдите новый</div>
        ) : (
          <>
            <header className="chats-header">
              <Avatar chat={selected} />
              <div className="chats-header__body">
                <div className="chats-header__title">{selected.title}</div>
                <div className="chats-item__sub">
                  {selected.username ? `@${selected.username} · ` : ''}
                  {KIND_LABEL[selected.kind]}
                  {selected.memberCount ? ` · ${selected.memberCount.toLocaleString('ru-RU')} участников` : ''}
                </div>
                {highlightMessageId != null && (
                  <div className="chats-publication-bar">
                    <span>Сообщение по ссылке</span>
                    {publicationLink && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={() => navigator.clipboard.writeText(publicationLink)}>
                        Скопировать ссылку
                      </button>
                    )}
                  </div>
                )}
              </div>
              {discussion && !discussion.spamReason && (
                discussion.isMember ? (
                  <button type="button" className="btn btn--sm" onClick={() => open(discussion)} title="Чат обсуждений канала">
                    Открыть чат канала
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--sm btn--primary"
                    onClick={() => join(discussion.chatId)}
                    title={`«${discussion.title}» — вступить без подписки на новости канала`}
                  >
                    Вступить в чат канала
                  </button>
                )
              )}
              {selected.spamReason ? (
                <span className="tag tag--warn" title={selected.spamReason}>спам-чат: {selected.spamReason}</span>
              ) : selected.isMember ? (
                selected.kind !== 'private' && (
                  <>
                    <button type="button" className="btn btn--sm" onClick={blockSpam}>Спам-чат</button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={leave}>Покинуть</button>
                  </>
                )
              ) : (
                <>
                  {selected.kind !== 'private' && <button type="button" className="btn btn--sm" onClick={blockSpam}>Спам-чат</button>}
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => join(selected.chatId)}>Вступить</button>
                </>
              )}
            </header>
            <div className="chats-timeline" ref={timelineRef}>
              {!noMore && items.length > 0 && (
                <button type="button" className="chats-older" onClick={loadOlder} disabled={loadingHistory}>
                  {loadingHistory ? 'Загружаю…' : 'Загрузить ранние сообщения'}
                </button>
              )}
              {loadingHistory && !items.length && <div className="crm-muted">Загружаю историю…</div>}
              {items.map((m) => {
                const quoted = m.replyToMessageId ? items.find((x) => x.messageId === m.replyToMessageId) : null;
                return (
                  <div
                    key={m.messageId}
                    ref={(el) => {
                      messageRefs.current[m.messageId] = el;
                    }}
                    className={`bubble bubble--${m.isOutgoing ? 'out' : 'in'}${
                      highlightMessageId === m.messageId ? ' bubble--highlight' : ''
                    }`}
                  >
                    {!m.isOutgoing && m.senderName && <div className="bubble__auto">{m.senderName}</div>}
                    {quoted && <div className="chats-quote">{quoted.text.slice(0, 120) || 'сообщение'}</div>}
                    {m.voice &&
                      (voiceUrls[m.messageId] ? (
                        <AudioPlayer src={voiceUrls[m.messageId]} durationSec={m.voice.durationSec} />
                      ) : (
                        <button type="button" className="btn btn--sm" onClick={() => playVoice(m)}>
                          Голосовое · {m.voice.durationSec} с — загрузить
                        </button>
                      ))}
                    {m.text && <div className="chats-text"><LinkText text={m.text} /></div>}
                    <div className="chats-meta">
                      <span>{timeLabel(m.date)}</span>
                      {selected.isMember && (
                        <button type="button" className="chats-reply" onClick={() => setReplyTo(m)}>Ответить</button>
                      )}
                      {m.link && (
                        <button type="button" className="chats-reply" onClick={() => navigator.clipboard.writeText(m.link!)}>Скопировать ссылку</button>
                      )}
                    </div>
                  </div>
                );
              })}
              {!loadingHistory && !items.length && <div className="crm-muted">Сообщений нет</div>}
            </div>
            {selected.isMember && selected.kind !== 'channel' ? (
              <div className="composer">
                {replyTo && (
                  <div className="chats-replying">
                    Ответ {replyTo.senderName ? `${replyTo.senderName}: ` : ''}«{replyTo.text.slice(0, 80)}»
                    <button type="button" className="chats-reply" onClick={() => setReplyTo(null)}>отменить</button>
                  </div>
                )}
                <textarea
                  className="text-input"
                  rows={3}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.metaKey) send();
                  }}
                  placeholder="Сообщение…"
                />
                <div className="composer__row">
                  <span className="crm-muted">Отправляется от аккаунта как обычное сообщение</span>
                  <button type="button" className="btn btn--sm btn--primary" onClick={send} disabled={!text.trim()}>
                    Отправить ⌘↩
                  </button>
                </div>
              </div>
            ) : (
              <div className="chats-readonly">
                {selected.isMember ? 'В канал пишут только администраторы' : 'Вступите, чтобы писать в этот чат'}
              </div>
            )}
          </>
        )}
      </section>

      {selected && selected.kind !== 'private' && projects.length > 0 && (
        <aside className="chats-side">
          <div className="section-title">Прослушка</div>
          <div className="crm-muted">Сообщения чата проверяет Jev по правилу тематики.</div>
          {projects.map((p) => {
            const source = (sources[p.id] ?? []).find((s) => s.tgChatId === selected.chatId);
            const listening = source ? source.status !== 'rejected' && source.status !== 'spam' : selected.isMember;
            return (
              <label key={p.id} className="chats-listen">
                <input
                  type="checkbox"
                  checked={listening}
                  disabled={!source || source.status === 'spam'}
                  onChange={(e) => source && setListening(p.id, source, e.target.checked)}
                />
                <span>
                  {p.name}
                  {!source && (
                    <span className="crm-muted">
                      {selected.isMember ? ' — подключится с первым новым сообщением' : ' — после вступления'}
                    </span>
                  )}
                </span>
              </label>
            );
          })}
        </aside>
      )}
    </>
  );
}

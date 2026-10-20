import { useEffect, useState } from 'react';
import type { ChatMessage, Lead, Source } from '../../../shared/types';
import { formatLeadDate, formatShortTime } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';
import { IconExternal } from './Icons';

type ChatPanelProps = {
  lead: Lead | null;
  source: Source | null;
};

export function ChatPanel({ lead, source }: ChatPanelProps) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [where, setWhere] = useState<'dm' | 'chat'>('dm');
  const [sendError, setSendError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);

  useEffect(() => {
    if (!lead) {
      setMessages([]);
      return;
    }
    getApi()
      .messages.list(lead.id)
      .then(setMessages)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [lead?.id, toast]);

  useEffect(() => {
    if (!lead) return;
    const off = getApi().onEvent((e) => {
      if (e.type === 'message:new' && e.message.leadId === lead.id) {
        setMessages((prev) => [...prev, e.message]);
      }
    });
    return off;
  }, [lead?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && lead && text.trim()) {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const send = async () => {
    if (!lead || !text.trim()) return;
    setSendError(null);
    try {
      await getApi().messages.send(lead.id, text.trim(), where);
      setText('');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  };

  const draft = async () => {
    if (!lead) return;
    setDrafting(true);
    try {
      const d = await getApi().messages.draft(lead.id);
      setText(d);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const open = (url: string) => {
    getApi().shell.openExternal(url).catch(() => window.open(url, '_blank'));
  };

  if (!lead) {
    return (
      <section className="panel panel--chat">
        <div className="empty-state">Выберите лида в списке</div>
      </section>
    );
  }

  const dialogMsgs = messages.filter((m) => m.id !== messages[0]?.id || messages.length === 1);
  const hasDialog = dialogMsgs.length > 0;
  const noAuthor = lead.authorUserId == null;

  return (
    <section className="panel panel--chat">
      <div className="chat-header">
        <div className="chat-header__title">{lead.authorName ?? 'Лид'}</div>
        <div className="chat-header__sub">{source?.title ?? 'Источник'}</div>
      </div>
      <div className="chat-body">
        <div className="quote-card">
          <div className="quote-card__text">{lead.text}</div>
          <div className="quote-card__meta">
            <span>{formatLeadDate(lead.date)}</span>
          </div>
          <div className="quote-card__actions no-drag">
            {lead.link && (
              <button type="button" className="btn btn--sm" onClick={() => open(lead.link!)}>
                Открыть публикацию <IconExternal />
              </button>
            )}
            {source?.username && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => open(`https://t.me/${source.username}`)}
              >
                Открыть источник <IconExternal />
              </button>
            )}
          </div>
        </div>
        {!hasDialog && <div className="empty-state">Переписки пока нет</div>}
        {dialogMsgs.map((m) => (
          <div key={m.id} className={`bubble bubble--${m.direction === 'in' ? 'in' : 'out'}`}>
            {m.auto && <div className="bubble__auto">автопилот</div>}
            {m.text}
            <div className="lead-card__date" style={{ marginTop: 4 }}>{formatShortTime(m.date)}</div>
          </div>
        ))}
      </div>
      <div className="composer no-drag">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Сообщение…"
          aria-label="Текст сообщения"
        />
        <div className="composer__row">
          <div className="segmented">
            <button
              type="button"
              className={where === 'dm' ? 'button--active' : ''}
              disabled={noAuthor}
              title={noAuthor ? 'Контакт не определён' : undefined}
              onClick={() => setWhere('dm')}
            >
              Лично
            </button>
            <button
              type="button"
              className={where === 'chat' ? 'button--active' : ''}
              onClick={() => setWhere('chat')}
            >
              В чате
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn--sm" onClick={draft} disabled={drafting}>
              {drafting ? '…' : 'ИИ-черновик'}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={send} disabled={!text.trim()}>
              Отправить
            </button>
          </div>
        </div>
        {sendError && <div className="composer__error">{sendError}</div>}
        {noAuthor && (
          <p className="composer__note">
            Контакт пока не определён. Исходная публикация доступна для просмотра.
          </p>
        )}
      </div>
    </section>
  );
}

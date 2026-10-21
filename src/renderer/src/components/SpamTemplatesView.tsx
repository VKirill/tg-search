import { useCallback, useEffect, useState } from 'react';
import type { SpamChat, SpamTemplate } from '../../../shared/types';
import { formatLeadDate } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

export function SpamTemplatesView() {
  const toast = useToast();
  const [templates, setTemplates] = useState<SpamTemplate[]>([]);
  const [chats, setChats] = useState<SpamChat[]>([]);

  const load = useCallback(async () => {
    const [t, c] = await Promise.all([getApi().spam.templates(), getApi().spam.chats()]);
    setTemplates(t);
    setChats(c);
  }, []);

  const unblock = async (c: SpamChat) => {
    try {
      await getApi().spam.unblockChat(c.tgChatId);
      toast(`«${c.title}» снова можно добавлять`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load().catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [load, toast]);

  const setStatus = async (id: number, status: SpamTemplate['status']) => {
    try {
      await getApi().spam.setTemplateStatus(id, status);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page-view page-view--spam">
      <div className="page-view__head">
        <h1>Спам-чаты</h1>
      </div>
      <p className="crm-muted page-view__intro">
        Чаты, где среди последних сообщений почти только спам и повторы или неделю нет новых сообщений. Из них вышли
        со всех аккаунтов, вступить или добавить их в источники нельзя.
      </p>
      {chats.length === 0 ? (
        <div className="empty-state">Спам-чатов пока нет.</div>
      ) : (
        <ul className="spam-list">
          {chats.map((c) => (
            <li key={c.tgChatId} className="spam-card">
              <div className="spam-card__head">
                <span className="tag tag--warn">спам-чат</span>
                <span className="crm-muted">{c.source === 'auto' ? 'авто' : 'владелец'}</span>
              </div>
              <p className="spam-card__sample">
                {c.title}
                {c.username && <span className="crm-muted"> · @{c.username}</span>}
              </p>
              <div className="spam-card__stats">
                <span>{c.reason}</span>
                <span>·</span>
                <span>{formatLeadDate(c.createdAt)}</span>
              </div>
              <div className="spam-card__actions">
                <button type="button" className="btn btn--sm" onClick={() => unblock(c)}>Разблокировать</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="page-view__head">
        <h1>Спам-шаблоны</h1>
      </div>
      <p className="crm-muted page-view__intro">
        Похожие тексты от разных авторов. «Не спам» — шаблон больше не скрывает лиды автоматически.
      </p>
      {templates.length === 0 ? (
        <div className="empty-state">Шаблонов пока нет.</div>
      ) : (
        <ul className="spam-list">
          {templates.map((t) => (
            <li key={t.id} className="spam-card">
              <div className="spam-card__head">
                <span className={`tag${t.status === 'spam' ? ' tag--warn' : ''}`}>{t.status === 'spam' ? 'спам' : 'разрешён'}</span>
                <span className="crm-muted">{t.source === 'auto' ? 'авто' : 'владелец'}</span>
              </div>
              <p className="spam-card__sample">{t.sample}</p>
              <div className="spam-card__stats">
                <span>{t.authors} авторов</span>
                <span>·</span>
                <span>{t.messages} сообщений</span>
                <span>·</span>
                <span>видели {formatLeadDate(t.lastSeenAt)}</span>
              </div>
              <div className="spam-card__actions">
                {t.status === 'spam' ? (
                  <button type="button" className="btn btn--sm" onClick={() => setStatus(t.id, 'allowed')}>Не спам</button>
                ) : (
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => setStatus(t.id, 'spam')}>Снова спам</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

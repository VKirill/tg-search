import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FactKind, MemoryEpisode, MemoryFact } from '../../../../shared/types';
import { FACT_KINDS, factKindLabel, formatDateShort, formatEpisodePeriod } from '../../utils/format';
import { getApi } from '../../hooks/useApi';

type CrmMemoryTabProps = {
  clientId: number;
  toast: (msg: string) => void;
};

export function CrmMemoryTab({ clientId, toast }: CrmMemoryTabProps) {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [episodes, setEpisodes] = useState<MemoryEpisode[]>([]);
  const [addKind, setAddKind] = useState<FactKind>('profile');
  const [addText, setAddText] = useState('');
  const [expandedEp, setExpandedEp] = useState<Record<number, boolean>>({});

  const load = useCallback(async () => {
    try {
      const [f, e] = await Promise.all([
        getApi().memory.facts(clientId),
        getApi().memory.episodes(clientId),
      ]);
      setFacts(f);
      setEpisodes(e);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [clientId, toast]);

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'memory:update' && e.clientId === clientId) load();
    });
    return off;
  }, [clientId, load]);

  const grouped = useMemo(() => {
    const map = new Map<FactKind, MemoryFact[]>();
    for (const k of FACT_KINDS) map.set(k, []);
    for (const f of facts.filter((x) => x.active)) {
      map.get(f.kind)?.push(f);
    }
    return map;
  }, [facts]);

  const addFact = async () => {
    const text = addText.trim();
    if (!text) {
      toast('Введите текст факта');
      return;
    }
    try {
      await getApi().memory.addFact(clientId, addKind, text);
      setAddText('');
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const removeFact = async (f: MemoryFact) => {
    if (!confirm('Убрать факт из активной памяти? История сохранится.')) return;
    try {
      await getApi().memory.removeFact(f.id);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="crm-tab crm-tab--memory">
      <section className="crm-subsection">
        <h3>Факты</h3>
        <div className="memory-add">
          <select value={addKind} onChange={(e) => setAddKind(e.target.value as FactKind)} aria-label="Тип факта">
            {FACT_KINDS.map((k) => (
              <option key={k} value={k}>{factKindLabel(k)}</option>
            ))}
          </select>
          <input
            className="text-input"
            placeholder="Новый факт…"
            value={addText}
            onChange={(e) => setAddText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addFact()}
          />
          <button type="button" className="btn btn--sm" onClick={addFact}>Добавить</button>
        </div>
        {FACT_KINDS.map((kind) => {
          const list = grouped.get(kind) ?? [];
          if (list.length === 0) return null;
          return (
            <div key={kind} className="memory-group">
              <div className="memory-group__title">{factKindLabel(kind)}</div>
              <ul className="memory-facts">
                {list.map((f) => (
                  <li key={f.id} className="memory-fact">
                    <p className="memory-fact__text">{f.text}</p>
                    <div className="memory-fact__meta">
                      {f.source && <span>{f.source}</span>}
                      <span>{formatDateShort(f.createdAt)}</span>
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => removeFact(f)}>
                        Удалить
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {facts.filter((f) => f.active).length === 0 && (
          <p className="crm-muted">Пока нет активных фактов — агент заполнит память по ходу диалога.</p>
        )}
      </section>
      <section className="crm-subsection">
        <h3>Эпизоды</h3>
        {episodes.length === 0 && <p className="crm-muted">Сжатые саммари переписки появятся после накопления сообщений.</p>}
        <ul className="memory-episodes">
          {episodes.map((ep) => {
            const open = expandedEp[ep.id];
            return (
              <li key={ep.id} className="memory-episode">
                <button
                  type="button"
                  className="memory-episode__head"
                  onClick={() => setExpandedEp((p) => ({ ...p, [ep.id]: !p[ep.id] }))}
                >
                  <span className="memory-episode__period">{formatEpisodePeriod(ep.fromMs, ep.toMs)}</span>
                  <span className="memory-episode__count">{ep.messages} сообщ.</span>
                  <span className="memory-episode__chev">{open ? '▾' : '▸'}</span>
                </button>
                <p className="memory-episode__summary">{ep.summary}</p>
                {open && (
                  <p className="memory-episode__full">{ep.summary}</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

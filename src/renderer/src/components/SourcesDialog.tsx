import { useEffect, useState } from 'react';
import type { Project, Source, SourceStatus } from '../../../shared/types';
import { formatLeadDate, sourceKindLabel, sourceStatusLabel } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { IconSearch } from './Icons';

type SourcesDialogProps = {
  project: Project;
  onClose: () => void;
  onChange: () => void;
};

export function SourcesDialog({ project, onClose, onChange }: SourcesDialogProps) {
  const toast = useToast();
  const [sources, setSources] = useState<Source[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [link, setLink] = useState('');
  const [menuId, setMenuId] = useState<number | null>(null);

  const load = () => {
    getApi()
      .sources.list(project.id)
      .then(setSources)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    load();
  }, [project.id]);

  const filtered = sources.filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()));

  const discover = async () => {
    try {
      const list = await getApi().sources.discover(project.id);
      setSources(list);
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const scan = async () => {
    const ids = selected.size ? [...selected] : undefined;
    try {
      await getApi().sources.scan(project.id, ids);
      load();
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const addLink = async () => {
    if (!link.trim()) return;
    try {
      await getApi().sources.add(project.id, link.trim());
      setLink('');
      load();
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const setStatus = async (id: number, status: SourceStatus) => {
    setMenuId(null);
    try {
      await getApi().sources.setStatus(id, status);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const checked = sources.filter((s) => s.lastScannedAt != null).length;
  const matches = sources.reduce((n, s) => n + s.matchedLeads, 0);

  return (
    <Modal title="Источники проекта" onClose={onClose} wide>
      <div className="search-row" style={{ padding: 0, marginBottom: 12 }}>
        <div className="search-field">
          <IconSearch size={14} />
          <input placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button type="button" className="btn btn--sm" onClick={discover}>Найти источники</button>
        <button type="button" className="btn btn--sm btn--primary" onClick={scan}>
          Сканировать выбранные · {selected.size || sources.length}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Ссылка или @username"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addLink()}
        />
        <button type="button" className="btn btn--sm" onClick={addLink}>Добавить</button>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
        Ключи поиска: {project.keywords.length}
      </p>
      <table className="sources-table">
        <thead>
          <tr>
            <th />
            <th>Источник</th>
            <th>Результат</th>
            <th>Статус</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((s) => (
            <tr key={s.id}>
              <td>
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setSelected(next);
                  }}
                />
              </td>
              <td>
                <div style={{ fontWeight: 500 }}>{s.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {sourceKindLabel(s.kind)} · {s.lastScannedAt ? formatLeadDate(s.lastScannedAt) : 'не проверен'}
                </div>
              </td>
              <td style={{ fontSize: 11 }}>
                {s.matchedLeads} из {s.checkedLeads || '—'} подходят
              </td>
              <td style={{ position: 'relative' }}>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={s.status === 'spam'}
                  title={s.status === 'spam' ? 'Разблокировать можно в разделе «Спам»' : undefined}
                  onClick={() => setMenuId(s.id)}
                >
                  {sourceStatusLabel(s.status)}
                </button>
                {menuId === s.id && (
                  <div className="menu-popup">
                    {(['active', 'candidate', 'rejected'] as SourceStatus[]).map((st) => (
                      <button key={st} type="button" onClick={() => setStatus(s.id, st)}>
                        {sourceStatusLabel(st)}
                      </button>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 16 }}>
        Проверено {checked} из {sources.length} источников · Совпадений: {matches}
      </p>
    </Modal>
  );
}

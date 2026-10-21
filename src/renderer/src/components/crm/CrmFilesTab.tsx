import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Asset, AssetRole, Lead } from '../../../../shared/types';
import { assetRoleLabel, formatDateShort } from '../../utils/format';
import { mediaDisplayUrl, isImageMime } from '../../utils/media';
import { getApi } from '../../hooks/useApi';

const ROLES: AssetRole[] = ['from_client', 'preview', 'delivered', 'working'];

type CrmFilesTabProps = {
  clientId: number;
  lead: Lead;
  toast: (msg: string) => void;
};

export function CrmFilesTab({ clientId, lead, toast }: CrmFilesTabProps) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<AssetRole | 'all'>('all');
  const [searching, setSearching] = useState(false);

  const load = useCallback(
    async (q?: string) => {
      try {
        setAssets(await getApi().memory.assets(clientId, q));
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
    },
    [clientId, toast],
  );

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'memory:update' && e.clientId === clientId) load();
    });
    return off;
  }, [clientId, load]);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearching(true);
      load(query.trim() || undefined).finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, load]);

  const visible = useMemo(() => {
    if (roleFilter === 'all') return assets;
    return assets.filter((a) => a.role === roleFilter);
  }, [assets, roleFilter]);

  const images = visible.filter((a) => isImageMime(a.mime));
  const docs = visible.filter((a) => !isImageMime(a.mime));

  const sendAsset = async (assetId: number) => {
    if (!confirm('Отправить этот файл клиенту в Telegram?')) return;
    try {
      await getApi().memory.sendAsset(lead.id, assetId);
      toast('Файл отправлен клиенту');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="crm-tab crm-tab--files">
      <div className="files-toolbar">
        <input
          className="text-input"
          placeholder="Поиск по подписи и тегам…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск файлов"
        />
        {searching && <span className="crm-muted files-toolbar__hint">Ищу…</span>}
      </div>
      <div className="files-filters" role="tablist" aria-label="Роль файла">
        <button
          type="button"
          className={`chip${roleFilter === 'all' ? ' chip--active' : ''}`}
          onClick={() => setRoleFilter('all')}
        >
          Все
        </button>
        {ROLES.map((r) => (
          <button
            key={r}
            type="button"
            className={`chip${roleFilter === r ? ' chip--active' : ''}`}
            onClick={() => setRoleFilter(r)}
          >
            {assetRoleLabel(r)}
          </button>
        ))}
      </div>
      {visible.length === 0 && <p className="crm-muted">Нет файлов по выбранным фильтрам.</p>}
      {images.length > 0 && (
        <div className="files-gallery">
          {images.map((a) => (
            <article key={a.id} className="asset-card asset-card--image">
              <img src={mediaDisplayUrl(a.path)} alt={a.caption || a.name} className="asset-card__thumb" />
              <div className="asset-card__body">
                <div className="asset-card__role">{assetRoleLabel(a.role)}</div>
                <p className="asset-card__caption">{a.caption || a.name}</p>
                {a.tags.length > 0 && (
                  <div className="asset-card__tags">{a.tags.map((t) => <span key={t} className="tag tag--sm">{t}</span>)}</div>
                )}
                <div className="asset-card__meta">{formatDateShort(a.createdAt)}</div>
                <div className="asset-card__actions">
                  <button type="button" className="btn btn--sm" onClick={() => sendAsset(a.id)}>Отправить клиенту</button>
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={() => getApi().dossier.open(lead.id).catch((e) => toast(e instanceof Error ? e.message : String(e)))}
                  >
                    В Finder
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      {docs.length > 0 && (
        <ul className="files-docs">
          {docs.map((a) => (
            <li key={a.id} className="asset-row">
              <div className="asset-row__icon" aria-hidden>📄</div>
              <div className="asset-row__main">
                <div className="asset-row__name">{a.name}</div>
                <div className="asset-row__caption">{a.caption}</div>
                <div className="asset-row__meta">
                  <span>{assetRoleLabel(a.role)}</span>
                  <span>{formatDateShort(a.createdAt)}</span>
                </div>
              </div>
              <div className="asset-row__actions">
                <button type="button" className="btn btn--sm" onClick={() => sendAsset(a.id)}>Отправить</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

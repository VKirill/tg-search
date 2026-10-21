import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiModel, AiModelsView, AiProvider, AiStatus } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { useToast } from './Toast';

const STATE: Record<AiStatus['state'], string> = {
  ready: 'работает',
  starting: 'запускается',
  installing: 'устанавливается',
  stopped: 'остановлен',
  error: 'ошибка',
};

const price = (m: AiModel) => (m.costIn || m.costOut ? `$${m.costIn}/${m.costOut} за 1М` : 'бесплатно или по подписке');

// The app's own OpenCode v2: status, the main chat model, helper models the router may use, providers and keys
export function AiEngineSection() {
  const toast = useToast();
  const api = getApi();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [view, setView] = useState<AiModelsView | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ id: '', name: '', baseURL: '', apiKey: '', models: '' });
  const fail = useCallback((e: unknown) => toast(e instanceof Error ? e.message : String(e)), [toast]);

  const load = useCallback(async () => {
    const [s, v, p] = await Promise.all([api.ai.status(), api.ai.models(), api.ai.providers()]);
    setStatus(s);
    setView(v);
    setProviders(p);
  }, [api]);

  useEffect(() => {
    load().catch(fail);
    return api.onEvent((e) => {
      if (e.type === 'ai:status') {
        setStatus(e.status);
        if (e.status.state === 'ready') api.ai.models().then(setView, () => {});
      }
    });
  }, [api, load, fail]);

  const byProvider = useMemo(() => {
    const groups = new Map<string, AiModel[]>();
    for (const m of view?.models ?? []) groups.set(m.providerID, [...(groups.get(m.providerID) ?? []), m]);
    return groups;
  }, [view]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const all = view?.models ?? [];
    const chosen = new Set([view?.main, ...(view?.helpers ?? [])]);
    const list = q ? all.filter((m) => `${m.ref} ${m.name}`.toLowerCase().includes(q)) : all.filter((m) => chosen.has(m.ref) || m.providerID !== 'openrouter');
    return list.slice(0, 200);
  }, [view, filter]);

  const setChoice = (main: string, helpers: string[]) => api.ai.setModels({ main, helpers }).then(setView, fail);

  const run = async (fn: () => Promise<string | number>, done: (r: string | number) => string) => {
    setBusy(true);
    try {
      toast(done(await fn()));
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const addProvider = () => run(async () => {
    await api.ai.saveProvider({
      id: form.id, name: form.name || form.id, kind: 'openai-compatible', baseURL: form.baseURL, apiKey: form.apiKey,
      models: form.models.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
    });
    setForm({ id: '', name: '', baseURL: '', apiKey: '', models: '' });
    return 0;
  }, () => 'Провайдер добавлен');

  return (
    <section className="ai-engine">
      <h2 className="section-title">ИИ-движок (OpenCode)</h2>
      <div className="ai-engine__status">
        <span className={`tag${status?.state === 'ready' ? '' : ' tag--warn'}`}>{status ? STATE[status.state] : '…'}</span>
        <span>OpenCode {status?.version ?? '—'}{status?.latest && status.latest !== status.version ? ` · доступна ${status.latest}` : ''}</span>
        {status?.checkedAt && <span className="crm-muted">проверено {formatLeadDate(status.checkedAt)}</span>}
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run(() => api.ai.checkUpdate(), (r) => String(r))}>Проверить обновления</button>
      </div>
      {status?.message && <p className="crm-muted">{status.message}</p>}
      <p className="crm-muted">Все запросы к моделям идут через собственный OpenCode приложения. Он обновляется сам раз в сутки.</p>

      <div className="field">
        <label>Основная модель — общение с клиентами</label>
        <select value={view?.main ?? ''} onChange={(e) => view && setChoice(e.target.value, view.helpers)}>
          {!view?.main && <option value="">— выберите —</option>}
          {[...byProvider.entries()].map(([pid, models]) => (
            <optgroup key={pid} label={providers.find((p) => p.id === pid)?.name ?? pid}>
              {models.filter((m) => m.tools).map((m) => (
                <option key={m.ref} value={m.ref}>{m.name}{m.vision ? ' 👁' : ''}{m.variants.length ? ' 🧠' : ''}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>

      <div className="field">
        <label>Вспомогательные модели — приложение само выбирает, кому что поручить и насколько думать</label>
        <input value={filter} placeholder="Поиск модели (например, gemini, claude, deepseek)" onChange={(e) => setFilter(e.target.value)} />
        <ul className="ai-models">
          {visible.map((m) => {
            const isMain = m.ref === view?.main;
            const checked = isMain || !!view?.helpers.includes(m.ref);
            return (
              <li key={m.ref}>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isMain}
                    onChange={(e) => view && setChoice(view.main, e.target.checked ? [...view.helpers, m.ref] : view.helpers.filter((h) => h !== m.ref))}
                  />
                  <span className="ai-models__name">{m.name}</span>
                  <span className="crm-muted">{m.providerID}</span>
                  {m.vision && <span className="tag" title="Видит картинки">👁 зрение</span>}
                  {m.variants.length > 0 && <span className="tag" title={`Уровни рассуждения: ${m.variants.join(', ')}`}>🧠 {m.variants.length}</span>}
                  {!m.tools && <span className="tag tag--warn">без инструментов</span>}
                  <span className="crm-muted">{price(m)}</span>
                  {isMain && <span className="tag">основная</span>}
                </label>
              </li>
            );
          })}
        </ul>
        <p className="crm-muted">Картинки — моделям с 👁; сложные задачи (решения, Директ) — самой сильной из отмеченных с высоким уровнем рассуждения; простые — самой дешёвой.</p>
      </div>

      <div className="field">
        <label>Провайдеры</label>
        <ul className="ai-providers">
          {providers.map((p) => (
            <li key={p.id}>
              <span className="ai-models__name">{p.name}</span>
              <span className="crm-muted">{p.kind === 'catalog' ? 'каталог OpenCode' : p.baseURL}</span>
              <span className={`tag${p.hasKey ? '' : ' tag--warn'}`}>{p.hasKey ? 'ключ есть' : 'нет ключа'}</span>
              {p.models > 0 && <span className="crm-muted">моделей: {p.models}</span>}
              <button type="button" className="btn btn--sm btn--ghost" onClick={() => confirm(`Убрать провайдера «${p.name}»?`) && run(async () => (await api.ai.removeProvider(p.id), 0), () => 'Провайдер убран')}>×</button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run(() => api.ai.importOpencode(), (n) => `Импортировано провайдеров: ${n}`)}>
          Импортировать из моего OpenCode
        </button>
      </div>

      <details className="ai-engine__add">
        <summary>Добавить OpenAI-совместимый провайдер</summary>
        <div className="ai-engine__form">
          <input placeholder="id (латиница), например openlux" value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          <input placeholder="Название" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="https://…/v1" value={form.baseURL} onChange={(e) => setForm({ ...form, baseURL: e.target.value })} />
          <input type="password" autoComplete="off" placeholder="API-ключ" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          <textarea rows={2} placeholder="Модели через запятую: gpt-6-sol, claude-sonnet-5-5" value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
          <button type="button" className="btn btn--sm btn--primary" disabled={busy || !form.id || !form.baseURL || !form.models} onClick={addProvider}>Сохранить</button>
        </div>
      </details>
    </section>
  );
}

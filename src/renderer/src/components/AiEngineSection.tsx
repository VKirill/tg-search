import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AiModel, AiModelsView, AiProvider, AiStatus } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { formatLeadDate } from '../utils/format';
import { RouteCheck } from './RouteCheck';
import { useToast } from './Toast';

const STATE: Record<AiStatus['state'], string> = {
  ready: 'работает',
  starting: 'запускается',
  installing: 'устанавливается',
  stopped: 'остановлен',
  error: 'ошибка',
};

const price = (m: AiModel) => (m.free ? 'бесплатно' : m.costIn || m.costOut ? `$${m.costIn} / $${m.costOut}` : 'подписка');
// catalog providers imported from OpenCode carry only their id
const KNOWN: Record<string, string> = { openrouter: 'OpenRouter', deepseek: 'DeepSeek', 'zai-coding-plan': 'Z.ai (GLM)', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
const plural = (n: number, one: string, few: string, many: string) =>
  n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
const modelsLabel = (n: number) => `${n} ${plural(n, 'модель', 'модели', 'моделей')}`;
// subscriptions (no price per token) take part in routing by themselves, like free models
const isSubscription = (m: AiModel) => m.providerID !== 'openrouter' && !m.costIn && !m.costOut;
const contextLabel = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}K`);

// «Gemini 4 Argon (OpenLux)» inside the OpenLux group reads as «Gemini 4 Argon»
function shortName(m: AiModel, providerName: string) {
  const suffix = /\s*\(([^)]+)\)\s*$/.exec(m.name);
  return suffix && providerName.toLowerCase().includes(suffix[1].toLowerCase()) ? m.name.slice(0, suffix.index) : m.name;
}

// The app's own OpenCode v2: status, the main chat model, helper models the router may use, providers and keys
export function AiEngineSection() {
  const toast = useToast();
  const api = getApi();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [view, setView] = useState<AiModelsView | null>(null);
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [mainProvider, setMainProvider] = useState('');
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

  const providerName = useCallback((id: string) => {
    const name = providers.find((p) => p.id === id)?.name ?? id;
    return name === id ? KNOWN[id] ?? id : name;
  }, [providers]);

  // provider → its models, providers with chosen models first, the huge OpenRouter catalog last
  const groups = useMemo(() => {
    const chosen = new Set([view?.main, ...(view?.helpers ?? [])]);
    const map = new Map<string, AiModel[]>();
    for (const m of view?.models ?? []) map.set(m.providerID, [...(map.get(m.providerID) ?? []), m]);
    return [...map.entries()]
      // free models first inside a provider
      .map(([id, models]) => ({
        id, name: providerName(id), models: [...models].sort((a, b) => Number(b.free) - Number(a.free)),
        chosen: models.filter((m) => chosen.has(m.ref)).length, free: models.filter((m) => m.free).length,
      }))
      .sort((a, b) => Number(b.chosen > 0) - Number(a.chosen > 0) || a.models.length - b.models.length);
  }, [view, providerName]);

  const mainModel = view?.models.find((m) => m.ref === view.main);
  const shownMainProvider = mainProvider || mainModel?.providerID || groups[0]?.id || '';
  const mainOptions = groups.find((g) => g.id === shownMainProvider)?.models.filter((m) => m.tools) ?? [];

  const q = filter.trim().toLowerCase();
  const matches = (m: AiModel) => !q || `${m.ref} ${m.name}`.toLowerCase().includes(q);

  const setChoice = (main: string, helpers: string[], useFree?: boolean) => api.ai.setModels({ main, helpers, useFree }).then(setView, fail);
  const freeCount = view?.models.filter((m) => m.free).length ?? 0;
  const toggleGroup = (id: string) => setOpen((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

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
    <div className="ai-engine">
      <section className="settings-card">
        <div className="settings-card__head">
          <h2 className="settings-card__title">ИИ-движок</h2>
          <span className={`status-dot${status?.state === 'ready' ? ' status-dot--ok' : status?.state === 'error' ? ' status-dot--err' : ''}`} />
          <span className="settings-card__meta">
            {status ? STATE[status.state] : '…'} · OpenCode {status?.version ?? '—'}
            {status?.latest && status.latest !== status.version ? ` · доступна ${status.latest}` : ''}
            {status?.checkedAt ? ` · проверено ${formatLeadDate(status.checkedAt)}` : ''}
          </span>
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run(() => api.ai.checkUpdate(), (r) => String(r))}>
            Проверить обновления
          </button>
        </div>
        {status?.message && <p className="field-hint">{status.message}</p>}
        <p className="field-hint">Все запросы к моделям идут через собственный OpenCode приложения. Он обновляется сам раз в сутки.</p>
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Основная модель</h2>
        <p className="field-hint">Ведёт переписку с клиентами. Нужна модель с инструментами.</p>
        <div className="ai-main">
          <div className="field">
            <label>Провайдер</label>
            <select value={shownMainProvider} onChange={(e) => setMainProvider(e.target.value)}>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name} ({g.models.filter((m) => m.tools).length})</option>)}
            </select>
          </div>
          <div className="field">
            <label>Модель</label>
            <select value={mainOptions.some((m) => m.ref === view?.main) ? view?.main : ''} onChange={(e) => view && e.target.value && setChoice(e.target.value, view.helpers)}>
              {!mainOptions.some((m) => m.ref === view?.main) && <option value="">— выберите —</option>}
              {mainOptions.map((m) => (
                <option key={m.ref} value={m.ref}>{shortName(m, providerName(m.providerID))}{m.vision ? ' · зрение' : ''}{m.variants.length ? ' · рассуждение' : ''}</option>
              ))}
            </select>
          </div>
        </div>
        {mainModel && (
          <div className="ai-main__current">
            Сейчас: <b>{mainModel.name}</b> <span className="crm-muted">{providerName(mainModel.providerID)}</span>
            <ModelBadges m={mainModel} />
          </div>
        )}
      </section>

      <section className="settings-card">
        <h2 className="settings-card__title">Вспомогательные модели</h2>
        <p className="field-hint">
          Приложение само выбирает, кому что поручить и насколько думать. Первыми идут модели по подписке (без цены за токены) и бесплатные:
          задача уходит той, чьи сильные стороны по описанию совпадают с нуждами агента. Отмеченные платные — запасные: сложное — самой сильной,
          простое — самой дешёвой.
        </p>
        {freeCount > 0 && (
          <label className="ai-free">
            <input type="checkbox" checked={!!view?.useFree} onChange={(e) => view && setChoice(view.main, view.helpers, e.target.checked)} />
            <span>
              <b>★ Бесплатные модели OpenRouter — первыми, без отметок</b>
              <span className="field-hint">
                {freeCount} {plural(freeCount, 'модель', 'модели', 'моделей')}. Для поручений и вспомогательной работы сначала пробуются они: приложение раз в сутки читает
                описания моделей на OpenRouter и отдаёт задачу той, чьи сильные стороны совпадают с нуждами агента (решателю — логика, копирайтеру — тексты).
                 Упёрлась в лимит или ошиблась — задачу берёт следующая модель, а сбойная отдыхает. Переписку с клиентом
                ведёт основная модель. Бесплатные модели могут сохранять запросы у себя — не включайте, если переписка конфиденциальна.
              </span>
            </span>
          </label>
        )}
        <input className="text-input" value={filter} placeholder="Поиск модели: gemini, claude, deepseek…" onChange={(e) => setFilter(e.target.value)} />
        <div className="ai-groups">
          {groups.map((g) => {
            const list = g.models.filter(matches);
            if (q && !list.length) return null;
            const expanded = q ? true : open.has(g.id);
            return (
              <div key={g.id} className={`ai-group${expanded ? ' ai-group--open' : ''}`}>
                <button type="button" className="ai-group__head" onClick={() => toggleGroup(g.id)}>
                  <span className="ai-group__chevron">›</span>
                  <span className="ai-group__name">{g.name}</span>
                  <span className="crm-muted">{q ? `найдено ${list.length}` : modelsLabel(g.models.length)}</span>
                  {g.free > 0 && <span className="tag tag--free">★ {g.free} бесплатно</span>}
                  {g.chosen > 0 && <span className="tag tag--category">отмечено {g.chosen}</span>}
                </button>
                {expanded && (
                  <ul className="ai-models">
                    {list.slice(0, 300).map((m) => {
                      const isMain = m.ref === view?.main;
                      const auto = (m.free && !!view?.useFree) || isSubscription(m);
                      const checked = isMain || auto || !!view?.helpers.includes(m.ref);
                      return (
                        <li key={m.ref}>
                          <label className={checked ? 'ai-model--on' : ''}>
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isMain || auto}
                              onChange={(e) => view && setChoice(view.main, e.target.checked ? [...view.helpers, m.ref] : view.helpers.filter((h) => h !== m.ref))}
                            />
                            <span className="ai-models__title">
                              <span className="ai-models__name">{shortName(m, g.name)}</span>
                              {m.summary && <span className="ai-models__summary">{m.summary}</span>}
                            </span>
                            {isMain && <span className="tag tag--category">основная</span>}
                            {auto && <span className="tag tag--free" title="Используется автоматически">★ авто</span>}
                            <ModelBadges m={m} />
                          </label>
                        </li>
                      );
                    })}
                    {list.length > 300 && <li className="crm-muted">…ещё {list.length - 300} — уточните поиск</li>}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <RouteCheck />

      <section className="settings-card">
        <h2 className="settings-card__title">Провайдеры</h2>
        <ul className="ai-providers">
          {providers.map((p) => (
            <li key={p.id}>
              <span className={`status-dot${p.hasKey ? ' status-dot--ok' : ' status-dot--err'}`} title={p.hasKey ? 'ключ есть' : 'нет ключа'} />
              <span className="ai-models__name">{providerName(p.id)}</span>
              <span className="crm-muted ai-providers__url">{p.kind === 'catalog' ? 'каталог OpenCode' : p.baseURL}</span>
              <span className="crm-muted">{modelsLabel(groups.find((g) => g.id === p.id)?.models.length ?? p.models)}</span>
              {!p.hasKey && <span className="tag tag--warn">нет ключа</span>}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                title="Убрать провайдера"
                onClick={() => confirm(`Убрать провайдера «${providerName(p.id)}»?`) && run(async () => (await api.ai.removeProvider(p.id), 0), () => 'Провайдер убран')}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="ai-providers__actions">
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
    </div>
  );
}

function ModelBadges({ m }: { m: AiModel }) {
  return (
    <span className="ai-badges">
      {m.strengths.map((s) => <span key={s} className="tag tag--category" title="Сильная сторона по описанию модели">{s}</span>)}
      {m.vision && <span className="tag" title="Видит картинки">зрение</span>}
      {m.variants.length > 0 && <span className="tag" title={`Уровни рассуждения: ${m.variants.join(', ')}`}>рассуждение ×{m.variants.length}</span>}
      {!m.tools && <span className="tag tag--warn">без инструментов</span>}
      {m.context > 0 && <span className="tag" title="Контекст, токенов">{contextLabel(m.context)}</span>}
      <span className={`ai-badges__price${m.free ? ' ai-badges__price--free' : ''}`} title="$ за 1М токенов: вход / выход">{price(m)}</span>
    </span>
  );
}

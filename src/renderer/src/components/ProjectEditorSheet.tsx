import { useEffect, useState } from 'react';
import type { Account, ManagerSettings, Project, ProjectInput, ProjectTask, SequenceStep, Source } from '../../../shared/types';
import { DEFAULT_MANAGER } from '../../../shared/types';
import { foundByLabel, sourceStatusLabel, taskLabel } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { AutopilotDialog } from './AutopilotDialog';
import { useToast } from './Toast';

const TABS = ['search', 'jev', 'chain', 'manager', 'sources', 'autopilot'] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  search: 'Что искать',
  jev: 'Правило Jev',
  chain: 'Цепочка',
  manager: 'ИИ-менеджер',
  sources: 'Источники',
  autopilot: 'Автопилот',
};

const TASKS: ProjectTask[] = ['clients', 'partners', 'investors', 'jobs', 'ads'];
const CRITERIA_TEMPLATES: Record<ProjectTask, string> = {
  clients: 'Подходит: явный запрос на разработку, MVP, бота. Не подходит: вакансии без проекта.',
  partners: 'Подходит: партнёрство, субподряд. Не подходит: продажа услуг конкурентам.',
  investors: 'Подходит: поиск инвестиций, питч. Не подходит: реклама фондов.',
  jobs: 'Подходит: вакансии в нашу команду. Не подходит: фриланс-заказы.',
  ads: 'Подходит: объявления о продаже. Не подходит: спам.',
};

type Props = {
  project: Project | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
};

export function ProjectEditorSheet({ project, accounts, onClose, onSaved }: Props) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('search');
  const [p, setP] = useState<ProjectInput & { id?: number }>(() => emptyProject());
  const [sources, setSources] = useState<Source[]>([]);
  const [csv, setCsv] = useState('');
  const [importResult, setImportResult] = useState<string | null>(null);
  const [sandboxIn, setSandboxIn] = useState('');
  const [sandboxHist, setSandboxHist] = useState<{ direction: 'in' | 'out'; text: string }[]>([]);
  const [sandboxOut, setSandboxOut] = useState('');
  const [showAutopilot, setShowAutopilot] = useState(false);
  const [liveProject, setLiveProject] = useState<Project | null>(project);

  useEffect(() => {
    const tabMatch = location.hash.match(/tab=(\w+)/);
    if (tabMatch && TABS.includes(tabMatch[1] as Tab)) setTab(tabMatch[1] as Tab);
    if (location.hash.includes('csvDemo')) {
      setImportResult('Добавлено: 3, пропущено: 1, ошибок: 1');
      setCsv('link\nhttps://t.me/chat1\n@chat2\nbad_link');
    }
  }, []);

  useEffect(() => {
    if (!project) {
      setP(emptyProject());
      setLiveProject(null);
      return;
    }
    setP({
      name: project.name,
      task: project.task,
      target: project.target,
      offer: project.offer,
      criteria: project.criteria,
      geo: [...project.geo],
      languages: [...project.languages],
      accountIds: [...project.accountIds],
      materials: [...project.materials],
      keywords: [...project.keywords],
      sequence: [...project.sequence],
      manager: { ...project.manager },
      id: project.id,
    });
    setLiveProject(project);
    getApi().sources.list(project.id).then(setSources).catch(() => {});
  }, [project]);

  const save = async () => {
    const { id, ...input } = p;
    try {
      if (id) await getApi().projects.update(id, input);
      else await getApi().projects.create(input);
      onSaved();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const patch = (partial: Partial<ProjectInput>) => setP((prev) => ({ ...prev, ...partial }));

  const importCsv = async () => {
    if (!p.id) return;
    try {
      const r = await getApi().sources.importCsv(p.id, csv);
      setImportResult(`Добавлено: ${r.added}, пропущено: ${r.skipped}, ошибок: ${r.failed.length}`);
      setSources(await getApi().sources.list(p.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const managerTest = async () => {
    if (!p.id && !project) {
      toast('Сначала сохраните тематику');
      return;
    }
    const pid = p.id ?? project!.id;
    try {
      const r = await getApi().manager.test(pid, sandboxIn, sandboxHist, p.manager);
      setSandboxHist([...sandboxHist, { direction: 'in', text: sandboxIn }, { direction: 'out', text: r.reply }]);
      setSandboxOut(r.handoff ? `${r.reply} [передача: ${r.reason}]` : r.reply);
      setSandboxIn('');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="editor-sheet-backdrop" onClick={onClose}>
      <div className="editor-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="editor-sheet__head">
          <h2>{project ? project.name : 'Новая тематика'}</h2>
          <div className="editor-sheet__actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={save}>Сохранить</button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>Закрыть</button>
          </div>
        </div>
        <div className="editor-tabs">
          {TABS.map((t) => (
            <button key={t} type="button" className={`editor-tab${tab === t ? ' editor-tab--active' : ''}`} onClick={() => setTab(t)}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="editor-sheet__body">
          {tab === 'search' && (
            <>
              <div className="field"><label>Название</label><input value={p.name} onChange={(e) => patch({ name: e.target.value })} /></div>
              <div className="field">
                <label>Задача</label>
                <select value={p.task} onChange={(e) => patch({ task: e.target.value as ProjectTask })}>
                  {TASKS.map((t) => <option key={t} value={t}>{taskLabel(t)}</option>)}
                </select>
              </div>
              <div className="field"><label>Кого ищем</label><textarea value={p.target} onChange={(e) => patch({ target: e.target.value })} /></div>
              <div className="field"><label>Оффер</label><textarea value={p.offer} onChange={(e) => patch({ offer: e.target.value })} /></div>
              <div className="field">
                <label>Ключевые фразы</label>
                <textarea value={p.keywords.join('\n')} onChange={(e) => patch({ keywords: e.target.value.split('\n').filter(Boolean) })} rows={3} />
                <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={async () => patch({ keywords: await getApi().projects.suggestKeywords(p) })}>Подобрать ключи</button>
              </div>
              <div className="field">
                <label>Аккаунты</label>
                {accounts.map((a) => (
                  <label key={a.id} className="checkbox-row">
                    <input type="checkbox" checked={p.accountIds.includes(a.id)} onChange={(e) => patch({ accountIds: e.target.checked ? [...p.accountIds, a.id] : p.accountIds.filter((id) => id !== a.id) })} />
                    {a.firstName ?? a.phone}
                  </label>
                ))}
              </div>
            </>
          )}
          {tab === 'jev' && (
            <>
              <div className="field">
                <label>Правило Jev (что подходит)</label>
                <textarea value={p.criteria} onChange={(e) => patch({ criteria: e.target.value })} rows={8} />
              </div>
              <button type="button" className="btn btn--sm" onClick={() => patch({ criteria: CRITERIA_TEMPLATES[p.task] })}>Шаблон для {taskLabel(p.task)}</button>
            </>
          )}
          {tab === 'chain' && (
            <ChainEditor sequence={p.sequence} onChange={(s) => patch({ sequence: s })} />
          )}
          {tab === 'manager' && (
            <>
              <label className="checkbox-row">
                <input type="checkbox" checked={p.manager.enabled} onChange={(e) => patch({ manager: { ...p.manager, enabled: e.target.checked } })} />
                ИИ-менеджер включён
              </label>
              {p.manager.enabled && <p className="crm-warn">Менеджер будет отвечать клиентам от вашего имени. Проверьте промпт и лимиты.</p>}
              <ManagerFields mgr={p.manager} onChange={(m) => patch({ manager: m })} />
              <div className="sandbox">
                <h3>Песочница</h3>
                <div className="sandbox__log">
                  {sandboxHist.map((h, i) => (
                    <div key={i} className={`bubble bubble--${h.direction === 'in' ? 'in' : 'out'}`}>{h.text}</div>
                  ))}
                  {sandboxOut && <div className="sandbox__last">{sandboxOut}</div>}
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input className="text-input" style={{ flex: 1 }} value={sandboxIn} onChange={(e) => setSandboxIn(e.target.value)} placeholder="Сообщение клиента…" onKeyDown={(e) => e.key === 'Enter' && managerTest()} />
                  <button type="button" className="btn btn--sm" onClick={managerTest}>Отправить</button>
                </div>
              </div>
            </>
          )}
          {tab === 'sources' && (
            <>
              <table className="sources-table">
                <thead><tr><th>Чат</th><th>Статус</th><th>Источник</th></tr></thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td>{s.title}</td>
                      <td>{sourceStatusLabel(s.status)}</td>
                      <td><span className="tag">{foundByLabel(s.foundBy)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="field" style={{ marginTop: 16 }}>
                <label>Импорт CSV</label>
                <textarea value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="link&#10;https://t.me/chat1&#10;@chat2" rows={4} />
                <button type="button" className="btn btn--sm" style={{ marginTop: 8 }} onClick={importCsv} disabled={!p.id}>Импорт CSV</button>
                {importResult && <p className="crm-muted">{importResult}</p>}
              </div>
            </>
          )}
          {tab === 'autopilot' && liveProject && (
            <button type="button" className="btn" onClick={() => setShowAutopilot(true)}>Открыть настройки автопилота</button>
          )}
          {tab === 'autopilot' && !liveProject && <p className="crm-muted">Сохраните тематику, чтобы настроить автопилот.</p>}
        </div>
      </div>
      {showAutopilot && liveProject && (
        <AutopilotDialog project={liveProject} accounts={accounts} onClose={() => setShowAutopilot(false)} onChange={setLiveProject} />
      )}
    </div>
  );
}

function emptyProject(): ProjectInput & { id?: number } {
  return {
    name: '',
    task: 'clients',
    target: '',
    offer: '',
    criteria: '',
    geo: [],
    languages: ['русский'],
    accountIds: [1],
    materials: [],
    keywords: [],
    sequence: [],
    manager: { ...DEFAULT_MANAGER },
  };
}

function ChainEditor({ sequence, onChange }: { sequence: SequenceStep[]; onChange: (s: SequenceStep[]) => void }) {
  const update = (i: number, step: SequenceStep) => {
    const next = [...sequence];
    next[i] = step;
    onChange(next);
  };
  return (
    <div className="chain-editor">
      {sequence.map((step, i) => (
        <div key={i} className="chain-step">
          <div className="chain-step__head">
            Шаг {i + 1}{i > 0 ? ` · через ${step.delayHours} ч, если молчит` : ' · первое сообщение'}
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onChange(sequence.filter((_, j) => j !== i))}>Удалить</button>
          </div>
          {i > 0 && (
            <div className="field">
              <label>Задержка (ч)</label>
              <input type="number" value={step.delayHours} onChange={(e) => update(i, { ...step, delayHours: Number(e.target.value) })} />
            </div>
          )}
          <div className="field">
            <label>Режим</label>
            <select value={step.mode} onChange={(e) => update(i, { ...step, mode: e.target.value as 'template' | 'ai' })}>
              <option value="template">Шаблон</option>
              <option value="ai">ИИ-инструкция</option>
            </select>
          </div>
          <textarea className="text-input" value={step.text} onChange={(e) => update(i, { ...step, text: e.target.value })} rows={3} />
          <div className="chip-row">
            {['{name}', '{request}'].map((c) => (
              <button key={c} type="button" className="chip" onClick={() => update(i, { ...step, text: step.text + c })}>{c}</button>
            ))}
          </div>
        </div>
      ))}
      <button type="button" className="btn btn--sm add-row-btn" onClick={() => onChange([...sequence, { delayHours: 24, mode: 'template', text: '' }])}>Добавить шаг</button>
      {sequence.length > 0 && (
        <div className="chain-preview">
          <h4>Превью шага 1</h4>
          <p>{sequence[0].text.replace('{name}', 'Иван').replace('{request}', 'нужен MVP')}</p>
        </div>
      )}
    </div>
  );
}

function ManagerFields({ mgr, onChange }: { mgr: ManagerSettings; onChange: (m: ManagerSettings) => void }) {
  const set = (partial: Partial<ManagerSettings>) => onChange({ ...mgr, ...partial });
  return (
    <>
      <div className="field">
        <label>Base URL (пусто = глобальный)</label>
        <select value={mgr.baseUrl || ''} onChange={(e) => set({ baseUrl: e.target.value })}>
          <option value="">Глобальный LLM</option>
          <option value="https://openrouter.ai/api/v1">OpenRouter</option>
          <option value="https://api.openai.com/v1">OpenAI</option>
        </select>
      </div>
      <div className="field"><label>API key</label><input type="password" value={mgr.apiKey} onChange={(e) => set({ apiKey: e.target.value })} /></div>
      <div className="field">
        <label>Модель</label>
        <input list="models" value={mgr.model} onChange={(e) => set({ model: e.target.value })} />
        <datalist id="models">
          <option value="anthropic/claude-sonnet-5.5" />
          <option value="anthropic/claude-haiku-5.5" />
          <option value="openai/gpt-5.6-terra" />
        </datalist>
      </div>
      <div className="field"><label>Промпт ({'{owner}'})</label><textarea value={mgr.prompt} onChange={(e) => set({ prompt: e.target.value })} rows={6} /></div>
      <div className="field"><label>Пауза перед ответом (сек)</label><input type="number" value={mgr.replyDelaySec} onChange={(e) => set({ replyDelaySec: Number(e.target.value) })} /></div>
      <div className="field"><label>Макс. ответов</label><input type="number" value={mgr.maxReplies} onChange={(e) => set({ maxReplies: Number(e.target.value) })} /></div>
      <div className="field">
        <label>Голосовые ответы</label>
        <select value={mgr.voiceReplies} onChange={(e) => set({ voiceReplies: e.target.value as 'never' | 'mirror' })}>
          <option value="never">Никогда</option>
          <option value="mirror">Голосом на голосовые</option>
        </select>
      </div>
    </>
  );
}

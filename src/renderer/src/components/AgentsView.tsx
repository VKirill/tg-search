import { useCallback, useEffect, useMemo, useState } from 'react';
import { MODEL_SKILLS, type AgentDef, type ToolPermission } from '../../../shared/types';
import {
  KNOWN_AGENT_TOOLS,
  TOOL_PERMISSIONS,
  agentModelLabel,
  toolPermissionLabel,
} from '../agentTools';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type SheetTab = 'agent' | 'rules';

// The model is a role; the router fills it from the models chosen in Settings → ИИ-движок
const MODEL_PRESETS = [
  { value: 'main', label: 'Основная — общение' },
  { value: 'fast', label: 'Быстрая — простые задачи' },
  { value: 'vision', label: 'Со зрением — картинки' },
  { value: 'smart', label: 'Умная — сложные задачи' },
] as const;

function emptyAgent(): AgentDef {
  return {
    name: '',
    description: '',
    mode: 'subagent',
    model: '',
    temperature: 0.4,
    steps: 8,
    needs: [],
    permission: { '*': 'allow' },
    prompt: '',
    builtIn: false,
  };
}

function permissionRows(permission: Record<string, ToolPermission>): { key: string; value: ToolPermission }[] {
  const keys = Object.keys(permission);
  const ordered = [
    ...keys.filter((k) => k === '*'),
    ...keys.filter((k) => k !== '*').sort((a, b) => a.localeCompare(b)),
  ];
  return ordered.map((key) => ({ key, value: permission[key] ?? 'deny' }));
}

export function AgentsView() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [rules, setRules] = useState('');
  const [sheetTab, setSheetTab] = useState<SheetTab>('agent');
  const [editing, setEditing] = useState<AgentDef | null>(null);
  const [modelMode, setModelMode] = useState<'preset' | 'custom'>('preset');

  const load = useCallback(async () => {
    const [list, rulesText] = await Promise.all([getApi().agents.list(), getApi().agents.rules()]);
    setAgents(list);
    setRules(rulesText);
  }, []);

  useEffect(() => {
    load().catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [load, toast]);

  useEffect(() => {
    if (location.hash.includes('tab=rules') || location.hash.includes('shot=agent-rules')) {
      setSheetTab('rules');
    }
  }, []);

  useEffect(() => {
    const name = location.hash.match(/agent=([\w-]+)/)?.[1];
    if (!name) return;
    const a = agents.find((x) => x.name === name);
    if (a) openAgent(a);
    if (location.hash.includes('tab=rules')) setSheetTab('rules');
  }, [agents]);

  const openAgent = (a: AgentDef) => {
    setEditing({ ...a, permission: { ...a.permission } });
    setSheetTab('agent');
    const preset = MODEL_PRESETS.some((p) => p.value === a.model);
    setModelMode(preset || !a.model ? 'preset' : 'custom');
  };

  const openRules = () => {
    setEditing(null);
    setSheetTab('rules');
  };

  const saveAgent = async () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      toast('Укажите имя файла агента');
      return;
    }
    try {
      await getApi().agents.save(editing);
      setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const resetBuiltin = async () => {
    if (!editing?.builtIn) return;
    if (!confirm('Сбросить агента к стандартным настройкам?')) return;
    try {
      await getApi().agents.remove(editing.name);
      const list = await getApi().agents.list();
      setAgents(list);
      const fresh = list.find((a) => a.name === editing.name);
      if (fresh) openAgent(fresh);
      toast('Сброшено к стандартному');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const saveRules = async () => {
    try {
      await getApi().agents.saveRules(rules);
      toast('Правила сохранены');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const patch = (partial: Partial<AgentDef>) => {
    if (!editing) return;
    setEditing({ ...editing, ...partial });
  };

  const setPermRow = (key: string, value: ToolPermission) => {
    if (!editing) return;
    patch({ permission: { ...editing.permission, [key]: value } });
  };

  const removePermRow = (key: string) => {
    if (!editing || key === '*') return;
    const next = { ...editing.permission };
    delete next[key];
    patch({ permission: next });
  };

  const [newPermTool, setNewPermTool] = useState('');
  const addPermRow = () => {
    const key = newPermTool.trim();
    if (!key || !editing) return;
    setPermRow(key, 'allow');
    setNewPermTool('');
  };

  const sheetOpen = editing != null || sheetTab === 'rules';

  const sorted = useMemo(
    () => [...agents].sort((a, b) => (a.mode === b.mode ? a.name.localeCompare(b.name) : a.mode === 'primary' ? -1 : 1)),
    [agents],
  );

  return (
    <div className="page-view page-view--agents">
      <div className="page-view__head">
        <h1>Агенты</h1>
        <div className="page-view__head-actions">
          <button type="button" className="btn btn--sm" onClick={openRules}>Правила компании</button>
          <button type="button" className="btn btn--primary btn--sm" onClick={() => openAgent(emptyAgent())}>Новый агент</button>
        </div>
      </div>

      <div className="agents-grid">
        {sorted.map((a) => (
          <article key={a.name} className="agent-card" onClick={() => openAgent(a)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && openAgent(a)}>
            <div className="agent-card__head">
              <h2 className="agent-card__name">{a.name}</h2>
              <div className="agent-card__badges">
                <span className={`tag${a.mode === 'primary' ? ' tag--accent' : ''}`}>{a.mode === 'primary' ? 'основной' : 'субагент'}</span>
                {a.builtIn && <span className="badge">встроенный</span>}
              </div>
            </div>
            <p className="agent-card__desc">{a.description || '—'}</p>
            <div className="agent-card__meta">
              <span>{agentModelLabel(a.model)}</span>
              <span>·</span>
              <span>{a.steps} шагов</span>
            </div>
          </article>
        ))}
      </div>

      {sheetOpen && (
        <div className="editor-sheet-backdrop" onClick={() => { setEditing(null); setSheetTab('agent'); }}>
          <div className="editor-sheet editor-sheet--wide" onClick={(e) => e.stopPropagation()}>
            <div className="editor-sheet__head">
              <div className="editor-tabs">
                <button type="button" className={`editor-tab${sheetTab === 'agent' ? ' editor-tab--active' : ''}`} onClick={() => setSheetTab('agent')} disabled={!editing}>
                  Агент
                </button>
                <button type="button" className={`editor-tab${sheetTab === 'rules' ? ' editor-tab--active' : ''}`} onClick={() => setSheetTab('rules')}>
                  Правила компании
                </button>
              </div>
              <div className="editor-sheet__actions">
                {sheetTab === 'agent' && editing && (
                  <>
                    {editing.builtIn && (
                      <button type="button" className="btn btn--sm btn--ghost" onClick={resetBuiltin}>Сбросить к стандартному</button>
                    )}
                    <button type="button" className="btn btn--primary btn--sm" onClick={saveAgent}>Сохранить</button>
                  </>
                )}
                {sheetTab === 'rules' && (
                  <button type="button" className="btn btn--primary btn--sm" onClick={saveRules}>Сохранить</button>
                )}
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => { setEditing(null); setSheetTab('agent'); }}>Закрыть</button>
              </div>
            </div>
            <div className="editor-sheet__body">
              {sheetTab === 'rules' && (
                <div className="field">
                  <label>RULES.md — правила для всех агентов</label>
                  <textarea className="code-editor" value={rules} onChange={(e) => setRules(e.target.value)} rows={22} spellCheck={false} />
                </div>
              )}
              {sheetTab === 'agent' && editing && (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>Имя файла</label>
                      <input value={editing.name} onChange={(e) => patch({ name: e.target.value })} disabled={editing.builtIn} />
                    </div>
                    <div className="field">
                      <label>Режим</label>
                      <select value={editing.mode} onChange={(e) => patch({ mode: e.target.value as AgentDef['mode'] })} disabled={editing.builtIn}>
                        <option value="primary">Основной</option>
                        <option value="subagent">Субагент</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label>Описание (для маршрутизации)</label>
                    <textarea value={editing.description} onChange={(e) => patch({ description: e.target.value })} rows={2} />
                  </div>
                  <div className="field-row">
                    <div className="field">
                      <label>Модель</label>
                      <select
                        value={modelMode === 'preset' ? editing.model : '__custom__'}
                        onChange={(e) => {
                          if (e.target.value === '__custom__') setModelMode('custom');
                          else {
                            setModelMode('preset');
                            patch({ model: e.target.value });
                          }
                        }}
                      >
                        {MODEL_PRESETS.map((p) => (
                          <option key={p.value || 'default'} value={p.value}>{p.label}</option>
                        ))}
                        <option value="__custom__">Своя модель…</option>
                      </select>
                      {modelMode === 'custom' && (
                        <input
                          className="field-inline-input"
                          placeholder="provider/model"
                          value={editing.model}
                          onChange={(e) => patch({ model: e.target.value })}
                        />
                      )}
                    </div>
                    <div className="field">
                      <label>Температура</label>
                      <input
                        type="number"
                        min={0}
                        max={2}
                        step={0.1}
                        value={editing.temperature ?? ''}
                        onChange={(e) => patch({ temperature: e.target.value === '' ? null : Number(e.target.value) })}
                      />
                    </div>
                    <div className="field">
                      <label>Шагов за ход</label>
                      <input type="number" min={1} max={32} value={editing.steps} onChange={(e) => patch({ steps: Number(e.target.value) })} />
                    </div>
                  </div>
                  <div className="field">
                    <label>Что нужно от модели — по этому выбирается бесплатная модель OpenRouter</label>
                    <div className="needs-row">
                      {Object.entries(MODEL_SKILLS).map(([k, label]) => (
                        <label key={k} className={`chip-check${editing.needs.includes(k) ? ' chip-check--on' : ''}`}>
                          <input
                            type="checkbox"
                            checked={editing.needs.includes(k)}
                            onChange={(e) => patch({ needs: e.target.checked ? [...editing.needs, k] : editing.needs.filter((n) => n !== k) })}
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="field">
                    <label>Инструменты</label>
                    <table className="perm-table">
                      <thead>
                        <tr><th>Инструмент / glob</th><th>Доступ</th><th /></tr>
                      </thead>
                      <tbody>
                        {permissionRows(editing.permission).map(({ key, value }) => (
                          <tr key={key}>
                            <td><code>{key}</code></td>
                            <td>
                              <select value={value} onChange={(e) => setPermRow(key, e.target.value as ToolPermission)}>
                                {TOOL_PERMISSIONS.map((p) => (
                                  <option key={p} value={p}>{toolPermissionLabel(p)}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              {key !== '*' && (
                                <button type="button" className="btn btn--ghost btn--sm" onClick={() => removePermRow(key)}>Удалить</button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="perm-add">
                      <input
                        list="known-tools"
                        value={newPermTool}
                        onChange={(e) => setNewPermTool(e.target.value)}
                        placeholder="reply или order_*"
                      />
                      <datalist id="known-tools">
                        {KNOWN_AGENT_TOOLS.map((t) => <option key={t} value={t} />)}
                      </datalist>
                      <button type="button" className="btn btn--sm" onClick={addPermRow}>Добавить</button>
                    </div>
                  </div>
                  <div className="field">
                    <label>Системный промпт</label>
                    <textarea className="code-editor" value={editing.prompt} onChange={(e) => patch({ prompt: e.target.value })} rows={14} spellCheck={false} />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SkillDef } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type Tab = 'active' | 'draft' | 'disabled';

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function sourceLabel(source: SkillDef['source']): string {
  const map: Record<SkillDef['source'], string> = {
    builtin: 'встроенное',
    owner: 'ваше',
    learned: 'выучено',
  };
  return map[source];
}

export function SkillsView() {
  const toast = useToast();
  const [skills, setSkills] = useState<SkillDef[]>([]);
  const [tab, setTab] = useState<Tab>('active');
  const [editing, setEditing] = useState<Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'> | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setSkills(await getApi().skills.list());
  }, []);

  useEffect(() => {
    load().catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [load, toast]);

  useEffect(() => {
    if (location.hash.includes('tab=draft')) setTab('draft');
    const name = location.hash.match(/skill=([\w-]+)/)?.[1];
    if (!name) return;
    const s = skills.find((x) => x.name === name);
    if (s) setEditing({ name: s.name, description: s.description, body: s.body, status: s.status, source: s.source });
  }, [skills]);

  const filtered = useMemo(() => {
    const status = tab === 'active' ? 'active' : tab === 'draft' ? 'draft' : 'disabled';
    return skills.filter((s) => s.status === status).sort((a, b) => a.name.localeCompare(b.name));
  }, [skills, tab]);

  const openNew = () => {
    setEditing({ name: '', description: '', body: '', status: 'active', source: 'owner' });
    setNameError(null);
  };

  const save = async () => {
    if (!editing) return;
    if (!NAME_RE.test(editing.name)) {
      setNameError('Имя: строчные латинские буквы, цифры и дефис (например wb-card)');
      return;
    }
    if (editing.description.length > 1024) {
      toast('Описание не длиннее 1024 символов');
      return;
    }
    setNameError(null);
    try {
      await getApi().skills.save(editing);
      setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const approve = async (name: string) => {
    try {
      await getApi().skills.approve(name);
      setEditing(null);
      load();
      toast('Умение утверждено');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (name: string) => {
    if (!confirm('Удалить умение?')) return;
    try {
      await getApi().skills.remove(name);
      if (editing?.name === name) setEditing(null);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const descLen = editing?.description.length ?? 0;

  return (
    <div className="page-view page-view--skills">
      <div className="page-view__head">
        <h1>Умения</h1>
        <button type="button" className="btn btn--primary btn--sm" onClick={openNew}>Новое умение</button>
      </div>
      <div className="skills-tabs">
        {([
          ['active', 'Активные'],
          ['draft', 'Черновики'],
          ['disabled', 'Отключённые'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`filter-chip${tab === id ? ' filter-chip--active' : ''}`}
            onClick={() => setTab(id)}
          >
            {label}
            <span className="skills-tab-count">{skills.filter((s) => s.status === id).length}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">Нет умений в этой вкладке.</div>
      ) : (
        <div className="skills-grid">
          {filtered.map((s) => (
            <article key={s.name} className={`skill-card${s.status === 'draft' ? ' skill-card--draft' : ''}`}>
              <div className="skill-card__head">
                <button type="button" className="skill-card__name" onClick={() => setEditing({ name: s.name, description: s.description, body: s.body, status: s.status, source: s.source })}>
                  {s.name}
                </button>
                <span className="badge">{sourceLabel(s.source)}</span>
              </div>
              <p className="skill-card__desc">{s.description}</p>
              <div className="skill-card__meta">
                Использований: {s.uses}
                {s.lessons.length > 0 && ` · уроков: ${s.lessons.length}`}
              </div>
              {s.status === 'draft' && (
                <div className="skill-card__draft-actions">
                  <button type="button" className="btn btn--primary btn--sm" onClick={() => approve(s.name)}>Утвердить</button>
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(s.name)}>Удалить</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {editing && (
        <div className="editor-sheet-backdrop" onClick={() => setEditing(null)}>
          <div className="editor-sheet editor-sheet--wide" onClick={(e) => e.stopPropagation()}>
            <div className="editor-sheet__head">
              <h2>{editing.status === 'draft' ? 'Черновик умения' : 'Редактор умения'}</h2>
              <div className="editor-sheet__actions">
                {editing.status === 'draft' && (
                  <>
                    <button type="button" className="btn btn--primary btn--sm" onClick={() => approve(editing.name)}>Утвердить</button>
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => remove(editing.name)}>Удалить</button>
                  </>
                )}
                <button type="button" className="btn btn--primary btn--sm" onClick={save}>Сохранить</button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEditing(null)}>Закрыть</button>
              </div>
            </div>
            <div className="editor-sheet__body">
              <div className="field">
                <label>Имя (папка)</label>
                <input
                  value={editing.name}
                  onChange={(e) => {
                    setNameError(null);
                    setEditing({ ...editing, name: e.target.value });
                  }}
                  disabled={editing.source === 'builtin'}
                />
                {nameError && <p className="field-error">{nameError}</p>}
              </div>
              <div className="field">
                <label>Описание · {descLen}/1024</label>
                <textarea
                  value={editing.description}
                  maxLength={1024}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                  rows={3}
                />
              </div>
              <div className="field">
                <label>Тело SKILL.md</label>
                <textarea className="code-editor" value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} rows={18} spellCheck={false} />
              </div>
              {(skills.find((s) => s.name === editing.name)?.lessons.length ?? 0) > 0 && (
                <div className="field">
                  <label>Уроки из прошлых заказов — добавляются к инструкции автоматически</label>
                  <ul className="skill-lessons">
                    {skills.find((s) => s.name === editing.name)!.lessons.map((l, i) => (
                      <li key={i}>
                        <span>{l}</span>
                        <button
                          type="button"
                          className="btn btn--sm btn--ghost"
                          aria-label="Удалить урок"
                          onClick={() => getApi().skills.removeLesson(editing.name, i).then(() => load(), (e) => toast(e instanceof Error ? e.message : String(e)))}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="field">
                <label>Статус</label>
                <select
                  value={editing.status}
                  onChange={(e) => setEditing({ ...editing, status: e.target.value as SkillDef['status'] })}
                  disabled={editing.status === 'draft'}
                >
                  <option value="active">Активное</option>
                  <option value="disabled">Отключено</option>
                  {editing.status === 'draft' && <option value="draft">Черновик</option>}
                </select>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

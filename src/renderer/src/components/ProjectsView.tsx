import { useEffect, useState } from 'react';
import type { Account, Project } from '../../../shared/types';
import { taskLabel } from '../utils/format';
import { ProjectEditorSheet } from './ProjectEditorSheet';
import { IconPlus } from './Icons';

type ProjectsViewProps = {
  accounts: Account[];
  projectList: Project[];
  onRefresh: () => void;
  onOpenServices?: () => void;
};

export function ProjectsView({ projectList, accounts, onRefresh, onOpenServices }: ProjectsViewProps) {
  const [editing, setEditing] = useState<Project | 'new' | null>(null);

  useEffect(() => {
    const m = location.hash.match(/editor=(\d+)/);
    if (m) {
      const p = projectList.find((x) => x.id === Number(m[1]));
      if (p) setEditing(p);
    }
  }, [projectList]);

  return (
    <div className="page-view">
      <div className="page-view__head">
        <h1>Тематики</h1>
        <button type="button" className="btn btn--primary btn--sm" onClick={() => setEditing('new')}>
          <IconPlus /> Новая
        </button>
      </div>
      <div className="project-grid">
        {projectList.map((p) => (
          <article key={p.id} className="project-card" onClick={() => setEditing(p)}>
            <div className="project-card__name">{p.name}</div>
            <div className="project-card__meta">{taskLabel(p.task)} · {p.accountIds.length} акк.</div>
            <div className="project-card__flags">
              {p.manager.enabled && <span className="badge">ИИ-менеджер</span>}
              {p.autopilot.enabled && <span className="badge">Автопилот</span>}
              {p.sequence.length > 0 && <span className="badge">Цепочка {p.sequence.length}</span>}
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <ProjectEditorSheet
          project={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); onRefresh(); }}
          onOpenServices={onOpenServices}
        />
      )}
    </div>
  );
}

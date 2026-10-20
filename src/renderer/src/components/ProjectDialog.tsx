import { useEffect, useState } from 'react';
import type { Account, Material, Project, ProjectInput, ProjectTask } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { taskLabel } from '../utils/format';
import { Modal } from './Modal';
import { useToast } from './Toast';

const TASKS: ProjectTask[] = ['clients', 'partners', 'investors', 'jobs', 'ads'];

type ProjectDialogProps = {
  project: Project | null;
  accounts: Account[];
  onClose: () => void;
  onSaved: () => void;
};

function TokenField({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (t && !values.includes(t)) onChange([...values, t]);
    setDraft('');
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div className="token-input">
        {values.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label="Удалить">×</button>
          </span>
        ))}
        <input
          style={{ border: 'none', background: 'transparent', flex: 1, minWidth: 80, outline: 'none' }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
          placeholder="Добавить…"
        />
      </div>
    </div>
  );
}

export function ProjectDialog({ project, accounts, onClose, onSaved }: ProjectDialogProps) {
  const toast = useToast();
  const edit = project != null;
  const [task, setTask] = useState<ProjectTask>('clients');
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [offer, setOffer] = useState('');
  const [geo, setGeo] = useState<string[]>([]);
  const [languages, setLanguages] = useState<string[]>([]);
  const [accountIds, setAccountIds] = useState<number[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [kwDraft, setKwDraft] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!project) return;
    setTask(project.task);
    setName(project.name);
    setTarget(project.target);
    setOffer(project.offer);
    setGeo([...project.geo]);
    setLanguages([...project.languages]);
    setAccountIds([...project.accountIds]);
    setMaterials([...project.materials]);
    setKeywords([...project.keywords]);
  }, [project]);

  const input: ProjectInput = {
    name,
    task,
    target,
    offer,
    geo,
    languages,
    accountIds,
    materials,
    keywords,
  };

  const suggest = async () => {
    setSuggesting(true);
    try {
      const k = await getApi().projects.suggestKeywords({
        task,
        target,
        offer,
        geo,
        languages,
        materials,
      });
      setKeywords(k);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      if (edit && project) await getApi().projects.update(project.id, input);
      else await getApi().projects.create(input);
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!project || !confirm('Удалить проект?')) return;
    try {
      await getApi().projects.remove(project.id);
      onSaved();
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const addUrl = () => {
    setMaterials([...materials, { kind: 'url', value: '' }]);
  };

  const footer = (
    <>
      {edit && (
        <button type="button" className="danger-text" onClick={remove}>
          Удалить проект
        </button>
      )}
      <div style={{ flex: 1 }} />
      <button type="button" className="btn" onClick={onClose}>Отмена</button>
      <button type="button" className="btn btn--primary" onClick={save} disabled={saving || !name.trim()}>
        {edit ? 'Сохранить' : 'Создать проект'}
      </button>
    </>
  );

  return (
    <Modal title={edit ? 'Редактировать проект' : 'Новый проект'} onClose={onClose} wide footer={footer}>
      <div className="field">
        <label>Задача</label>
        <div className="segmented">
          {TASKS.map((t) => (
            <button
              key={t}
              type="button"
              className={task === t ? 'button--active' : ''}
              onClick={() => setTask(t)}
            >
              {taskLabel(t)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Название</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Кого или что найти</label>
        <textarea value={target} onChange={(e) => setTarget(e.target.value)} />
      </div>
      <div className="field">
        <label>Что важно · необязательно</label>
        <textarea value={offer} onChange={(e) => setOffer(e.target.value)} />
      </div>
      <TokenField label="География" values={geo} onChange={setGeo} />
      <TokenField label="Языки" values={languages} onChange={setLanguages} />
      <div className="field">
        <label>Аккаунты проекта</label>
        {accounts.map((a) => (
          <label key={a.id} className="checkbox-row">
            <input
              type="checkbox"
              checked={accountIds.includes(a.id)}
              onChange={(e) => {
                if (e.target.checked) setAccountIds([...accountIds, a.id]);
                else setAccountIds(accountIds.filter((id) => id !== a.id));
              }}
            />
            {a.firstName ?? a.username ?? a.phone}
          </label>
        ))}
      </div>
      <div className="field">
        <label>Материалы</label>
        {materials.map((m, i) => (
          <input
            key={i}
            value={m.value}
            onChange={(e) => {
              const next = [...materials];
              next[i] = { ...m, value: e.target.value };
              setMaterials(next);
            }}
            placeholder="URL"
            style={{ marginBottom: 6 }}
          />
        ))}
        <button type="button" className="btn btn--sm" onClick={addUrl}>Добавить URL</button>
        <input
          type="file"
          style={{ marginTop: 8, fontSize: 12 }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) setMaterials([...materials, { kind: 'file', value: (f as File & { path?: string }).path ?? f.name }]);
          }}
        />
      </div>
      <div className="field">
        <label>Поиск</label>
        <button type="button" className="btn btn--sm" onClick={suggest} disabled={suggesting}>
          {suggesting ? 'Подбор…' : 'Подобрать ключи'}
        </button>
        <div className="token-input" style={{ marginTop: 8 }}>
          {keywords.map((k) => (
            <span key={k} className="chip">
              {k}
              <button type="button" onClick={() => setKeywords(keywords.filter((x) => x !== k))}>×</button>
            </span>
          ))}
          <input
            style={{ border: 'none', background: 'transparent', flex: 1, outline: 'none' }}
            value={kwDraft}
            onChange={(e) => setKwDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && kwDraft.trim()) {
                e.preventDefault();
                setKeywords([...keywords, kwDraft.trim()]);
                setKwDraft('');
              }
            }}
            placeholder="Добавить ключ…"
          />
        </div>
      </div>
    </Modal>
  );
}

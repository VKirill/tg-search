import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { Modal } from './Modal';
import { useToast } from './Toast';

type SettingsDialogProps = {
  onClose: () => void;
};

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getApi()
      .settings.get()
      .then(setS)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [toast]);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      await getApi().settings.set(s);
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!s) return <Modal title="Настройки" onClose={onClose}>Загрузка…</Modal>;

  return (
    <Modal
      title="Настройки"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={saving}>Сохранить</button>
        </>
      }
    >
      <div className="field">
        <label>
          Telegram api_id ·{' '}
          <a
            href="https://my.telegram.org/apps"
            onClick={(e) => {
              e.preventDefault();
              getApi().shell.openExternal('https://my.telegram.org/apps');
            }}
          >
            my.telegram.org/apps
          </a>
        </label>
        <input value={s.tgApiId} onChange={(e) => setS({ ...s, tgApiId: e.target.value })} />
      </div>
      <div className="field">
        <label>api_hash</label>
        <input type="password" autoComplete="off" value={s.tgApiHash} onChange={(e) => setS({ ...s, tgApiHash: e.target.value })} />
      </div>
      <div className="field">
        <label>LLM base URL</label>
        <input value={s.llmBaseUrl} onChange={(e) => setS({ ...s, llmBaseUrl: e.target.value })} />
      </div>
      <div className="field">
        <label>API key</label>
        <input type="password" value={s.llmApiKey} onChange={(e) => setS({ ...s, llmApiKey: e.target.value })} />
      </div>
      <div className="field">
        <label>Модель</label>
        <input value={s.llmModel} onChange={(e) => setS({ ...s, llmModel: e.target.value })} />
      </div>
    </Modal>
  );
}

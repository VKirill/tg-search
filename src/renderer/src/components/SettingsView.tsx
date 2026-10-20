import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

const TTS_VOICES = ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'sage', 'coral'];

export function SettingsView() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    getApi().settings.get().then(setS).catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [toast]);

  const save = async () => {
    if (!s) return;
    setSaving(true);
    try {
      setS(await getApi().settings.set(s));
      toast('Сохранено');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const previewVoice = async () => {
    if (!s) return;
    setPreviewing(true);
    try {
      const path = await getApi().voice.preview('Здравствуйте! Это тестовая озвучка.');
      const audio = new Audio(path);
      audio.play();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setPreviewing(false);
    }
  };

  if (!s) return <div className="page-view"><div className="empty-state">Загрузка…</div></div>;

  return (
    <div className="page-view page-view--settings">
      <div className="page-view__head">
        <h1>Настройки</h1>
        <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={saving}>Сохранить</button>
      </div>
      <div className="settings-grid">
        <section>
          <h2 className="section-title">Telegram</h2>
          <div className="field"><label>api_id</label><input value={s.tgApiId} onChange={(e) => setS({ ...s, tgApiId: e.target.value })} /></div>
          <div className="field"><label>api_hash</label><input value={s.tgApiHash} onChange={(e) => setS({ ...s, tgApiHash: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">Владелец</h2>
          <div className="field"><label>Имя (помощник)</label><input value={s.ownerName} onChange={(e) => setS({ ...s, ownerName: e.target.value })} /></div>
          <div className="field"><label>Кому сообщать о передаче (@username)</label><input value={s.handoffNotifyTo} onChange={(e) => setS({ ...s, handoffNotifyTo: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">Jev</h2>
          <div className="field"><label>Base URL</label><input value={s.jevBaseUrl} onChange={(e) => setS({ ...s, jevBaseUrl: e.target.value })} /></div>
          <div className="field"><label>API key</label><input type="password" value={s.jevApiKey} onChange={(e) => setS({ ...s, jevApiKey: e.target.value })} /></div>
          <div className="field"><label>Модель</label><input value={s.jevModel} onChange={(e) => setS({ ...s, jevModel: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">LLM</h2>
          <div className="field"><label>Base URL</label><input value={s.llmBaseUrl} onChange={(e) => setS({ ...s, llmBaseUrl: e.target.value })} /></div>
          <div className="field"><label>API key</label><input type="password" value={s.llmApiKey} onChange={(e) => setS({ ...s, llmApiKey: e.target.value })} /></div>
          <div className="field"><label>Модель</label><input value={s.llmModel} onChange={(e) => setS({ ...s, llmModel: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">Речь</h2>
          <div className="field"><label>STT base URL</label><input value={s.sttBaseUrl} onChange={(e) => setS({ ...s, sttBaseUrl: e.target.value })} /></div>
          <div className="field"><label>STT key</label><input type="password" value={s.sttApiKey} onChange={(e) => setS({ ...s, sttApiKey: e.target.value })} /></div>
          <div className="field"><label>STT модель</label><input value={s.sttModel} onChange={(e) => setS({ ...s, sttModel: e.target.value })} /></div>
          <div className="field"><label>TTS base URL</label><input value={s.ttsBaseUrl} onChange={(e) => setS({ ...s, ttsBaseUrl: e.target.value })} /></div>
          <div className="field"><label>TTS key</label><input type="password" value={s.ttsApiKey} onChange={(e) => setS({ ...s, ttsApiKey: e.target.value })} /></div>
          <div className="field"><label>TTS модель</label><input value={s.ttsModel} onChange={(e) => setS({ ...s, ttsModel: e.target.value })} /></div>
          <div className="field">
            <label>Голос TTS</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <select value={s.ttsVoice} onChange={(e) => setS({ ...s, ttsVoice: e.target.value })}>
                {TTS_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
              <button type="button" className="btn btn--sm" onClick={previewVoice} disabled={previewing}>Прослушать</button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

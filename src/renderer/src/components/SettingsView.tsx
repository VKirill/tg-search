import { useEffect, useState } from 'react';
import type { Settings } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { TrustedSection } from './TrustedSection';
import { AiEngineSection } from './AiEngineSection';
import { useToast } from './Toast';

const TTS_VOICES = ['alloy', 'nova', 'shimmer', 'echo', 'onyx', 'fable', 'sage', 'coral'];

// Settings by area; «ИИ-движок» saves on every change, the rest with the «Сохранить» button
const TABS = [
  { id: 'ai', label: 'ИИ-движок', hint: 'Модели, провайдеры и сам OpenCode' },
  { id: 'agent', label: 'Агент', hint: 'От чьего имени пишет агент, и кому задания бесплатно' },
  { id: 'telegram', label: 'Telegram', hint: 'Доступ к Telegram API для аккаунтов' },
  { id: 'search', label: 'Поиск и анализ', hint: 'Квалификация лидов (Jev) и поиск в интернете' },
  { id: 'media', label: 'Медиа и голос', hint: 'Картинки, распознавание и озвучка голосовых' },
  { id: 'payments', label: 'Оплата', hint: 'Приём оплаты от клиентов' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const AUTOSAVED: TabId[] = ['ai'];

export function SettingsView() {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [tab, setTabState] = useState<TabId>(() => (TABS.find((t) => t.id === localStorage.getItem('settings.tab'))?.id ?? 'ai'));
  const setTab = (id: TabId) => {
    localStorage.setItem('settings.tab', id);
    setTabState(id);
  };

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

  const current = TABS.find((t) => t.id === tab)!;

  return (
    <div className="page-view page-view--settings">
      <div className="page-view__head">
        <h1>Настройки</h1>
        {!AUTOSAVED.includes(tab) && <button type="button" className="btn btn--primary btn--sm" onClick={save} disabled={saving}>Сохранить</button>}
      </div>
      <nav className="settings-tabs">
        {TABS.map((t) => (
          <button key={t.id} type="button" className={t.id === tab ? 'settings-tabs__tab settings-tabs__tab--active' : 'settings-tabs__tab'} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <p className="field-hint">{current.hint}</p>
      <div className="settings-grid">
        {tab === 'ai' && <AiEngineSection />}
        {tab === 'agent' && (
          <>
            <section>
              <h2 className="section-title">Владелец</h2>
              <div className="field"><label>Имя (помощник)</label><input value={s.ownerName} onChange={(e) => setS({ ...s, ownerName: e.target.value })} /></div>
              <div className="field"><label>Кому сообщать о передаче (@username)</label><input value={s.handoffNotifyTo} onChange={(e) => setS({ ...s, handoffNotifyTo: e.target.value })} /></div>
            </section>
            <TrustedSection />
          </>
        )}
        {tab === 'telegram' && (
          <>
            <section>
              <h2 className="section-title">Telegram</h2>
              <div className="field"><label>api_id</label><input value={s.tgApiId} onChange={(e) => setS({ ...s, tgApiId: e.target.value })} /></div>
              <div className="field"><label>api_hash</label><input type="password" autoComplete="off" value={s.tgApiHash} onChange={(e) => setS({ ...s, tgApiHash: e.target.value })} /></div>
            </section>
          </>
        )}
        {tab === 'search' && (
          <>
            <section>
              <h2 className="section-title">Квалификация лидов (Jev)</h2>
              <div className="field"><label>Base URL</label><input value={s.jevBaseUrl} onChange={(e) => setS({ ...s, jevBaseUrl: e.target.value })} /></div>
              <div className="field"><label>API key</label><input type="password" value={s.jevApiKey} onChange={(e) => setS({ ...s, jevApiKey: e.target.value })} /></div>
              <div className="field"><label>Модель</label><input value={s.jevModel} onChange={(e) => setS({ ...s, jevModel: e.target.value })} /></div>
              <div className="field"><label>Цена, $ за 1 млн входных токенов (для статистики)</label><input value={s.jevPricePerMTok} onChange={(e) => setS({ ...s, jevPricePerMTok: e.target.value })} /></div>
              <div className="field"><label>Порог «это запрос» (0–1): ниже — болтовня, тематики её не проверяют</label><input value={s.requestThreshold} onChange={(e) => setS({ ...s, requestThreshold: e.target.value })} /></div>
            </section>
            <section>
              <h2 className="section-title">Поиск в интернете (Tavily)</h2>
              <p className="field-hint">Для исполнителя «ассистент»: поиск и исследования по поручениям подписчиков.</p>
              <div className="field">
                <label>API key</label>
                <input type="password" autoComplete="off" value={s.tavilyApiKey} onChange={(e) => setS({ ...s, tavilyApiKey: e.target.value })} />
              </div>
              <div className="field">
                <label>Ключ Gemini (Google AI Studio) — запасной поиск через Google</label>
                <input type="password" autoComplete="off" value={s.geminiApiKey} onChange={(e) => setS({ ...s, geminiApiKey: e.target.value })} />
              </div>
            </section>
          </>
        )}
        {tab === 'media' && (
          <>
            <section>
              <h2 className="section-title">Изображения (fal.ai)</h2>
              <div className="field"><label>API key</label><input type="password" autoComplete="off" value={s.falKey} onChange={(e) => setS({ ...s, falKey: e.target.value })} /></div>
              <div className="field"><label>Модель</label><input value={s.imageModel} onChange={(e) => setS({ ...s, imageModel: e.target.value })} /></div>
            </section>
            <section>
              <h2 className="section-title">Голосовые</h2>
              <div className="field"><label>Распознавание (Groq и др.): base URL</label><input value={s.sttBaseUrl} onChange={(e) => setS({ ...s, sttBaseUrl: e.target.value })} /></div>
              <div className="field"><label>Распознавание: ключ</label><input type="password" value={s.sttApiKey} onChange={(e) => setS({ ...s, sttApiKey: e.target.value })} /></div>
              <div className="field"><label>Распознавание: модель</label><input value={s.sttModel} onChange={(e) => setS({ ...s, sttModel: e.target.value })} /></div>
              <div className="field"><label>Озвучка: base URL</label><input value={s.ttsBaseUrl} onChange={(e) => setS({ ...s, ttsBaseUrl: e.target.value })} /></div>
              <div className="field"><label>Озвучка: ключ</label><input type="password" value={s.ttsApiKey} onChange={(e) => setS({ ...s, ttsApiKey: e.target.value })} /></div>
              <div className="field"><label>Озвучка: модель</label><input value={s.ttsModel} onChange={(e) => setS({ ...s, ttsModel: e.target.value })} /></div>
              <div className="field">
                <label>Голос озвучки</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select value={s.ttsVoice} onChange={(e) => setS({ ...s, ttsVoice: e.target.value })}>
                    {TTS_VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <button type="button" className="btn btn--sm" onClick={previewVoice} disabled={previewing}>Прослушать</button>
                </div>
              </div>
            </section>
          </>
        )}
        {tab === 'payments' && (
          <>
            <section>
              <h2 className="section-title">Оплата (ЮKassa)</h2>
              <p className="field-hint">Сейчас тестовый магазин — после проверки подключите рабочий.</p>
              <div className="field"><label>Shop ID</label><input value={s.yookassaShopId} onChange={(e) => setS({ ...s, yookassaShopId: e.target.value })} /></div>
              <div className="field"><label>Секретный ключ</label><input type="password" autoComplete="off" value={s.yookassaSecretKey} onChange={(e) => setS({ ...s, yookassaSecretKey: e.target.value })} /></div>
              <div className="field"><label>Return URL</label><input value={s.yookassaReturnUrl} onChange={(e) => setS({ ...s, yookassaReturnUrl: e.target.value })} placeholder="https://t.me/your_bot" /></div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

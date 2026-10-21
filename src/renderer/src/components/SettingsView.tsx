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
          <div className="field"><label>api_hash</label><input type="password" autoComplete="off" value={s.tgApiHash} onChange={(e) => setS({ ...s, tgApiHash: e.target.value })} /></div>
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
          <div className="field"><label>Цена, $ за 1 млн входных токенов (для статистики)</label><input value={s.jevPricePerMTok} onChange={(e) => setS({ ...s, jevPricePerMTok: e.target.value })} /></div>
          <div className="field"><label>Порог «это запрос» (0–1): ниже — болтовня, тематики её не проверяют</label><input value={s.requestThreshold} onChange={(e) => setS({ ...s, requestThreshold: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">LLM</h2>
          <div className="field"><label>Base URL</label><input value={s.llmBaseUrl} onChange={(e) => setS({ ...s, llmBaseUrl: e.target.value })} /></div>
          <div className="field"><label>API key</label><input type="password" value={s.llmApiKey} onChange={(e) => setS({ ...s, llmApiKey: e.target.value })} /></div>
          <div className="field"><label>Модель</label><input value={s.llmModel} onChange={(e) => setS({ ...s, llmModel: e.target.value })} /></div>
        </section>
        <section>
          <h2 className="section-title">Оператор (ведёт диалоги)</h2>
          <p className="field-hint">Дешёвая модель с вызовом инструментов: ответы клиентам, память, заказы, подписки.</p>
          <div className="field">
            <label>Base URL</label>
            <div className="settings-presets">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setS({ ...s, operatorBaseUrl: 'https://api.deepseek.com/v1' })}
              >
                DeepSeek
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setS({ ...s, operatorBaseUrl: 'https://openrouter.ai/api/v1' })}
              >
                OpenRouter
              </button>
            </div>
            <input
              value={s.operatorBaseUrl}
              onChange={(e) => setS({ ...s, operatorBaseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
          </div>
          <div className="field">
            <label>API key</label>
            <input type="password" autoComplete="off" value={s.operatorApiKey} onChange={(e) => setS({ ...s, operatorApiKey: e.target.value })} />
          </div>
          <div className="field">
            <label>Модель</label>
            <input
              value={s.operatorModel}
              onChange={(e) => setS({ ...s, operatorModel: e.target.value })}
              placeholder="deepseek-flash"
            />
          </div>
        </section>
        <section>
          <h2 className="section-title">Поиск в интернете (Tavily)</h2>
          <p className="field-hint">Для исполнителя «ассистент»: поиск и исследования по поручениям подписчиков.</p>
          <div className="field">
            <label>API key</label>
            <input type="password" autoComplete="off" value={s.tavilyApiKey} onChange={(e) => setS({ ...s, tavilyApiKey: e.target.value })} />
          </div>
        </section>
        <section>
          <h2 className="section-title">Оплата (ЮKassa)</h2>
          <p className="field-hint">Сейчас тестовый магазин — после проверки подключите рабочий.</p>
          <div className="field"><label>Shop ID</label><input value={s.yookassaShopId} onChange={(e) => setS({ ...s, yookassaShopId: e.target.value })} /></div>
          <div className="field"><label>Секретный ключ</label><input type="password" autoComplete="off" value={s.yookassaSecretKey} onChange={(e) => setS({ ...s, yookassaSecretKey: e.target.value })} /></div>
          <div className="field"><label>Return URL</label><input value={s.yookassaReturnUrl} onChange={(e) => setS({ ...s, yookassaReturnUrl: e.target.value })} placeholder="https://t.me/your_bot" /></div>
        </section>
        <section>
          <h2 className="section-title">Вспомогательная модель (подноготная клиентов)</h2>
          <div className="field"><label>Base URL</label><input value={s.auxBaseUrl} onChange={(e) => setS({ ...s, auxBaseUrl: e.target.value })} placeholder="https://9router.example/v1" /></div>
          <div className="field"><label>API key</label><input type="password" autoComplete="off" value={s.auxApiKey} onChange={(e) => setS({ ...s, auxApiKey: e.target.value })} /></div>
          <div className="field"><label>Модель</label><input value={s.auxModel} onChange={(e) => setS({ ...s, auxModel: e.target.value })} placeholder="ag/gemini-3.8-flash" /></div>
        </section>
        <section>
          <h2 className="section-title">Изображения (fal.ai)</h2>
          <div className="field"><label>API key</label><input type="password" autoComplete="off" value={s.falKey} onChange={(e) => setS({ ...s, falKey: e.target.value })} /></div>
          <div className="field"><label>Модель</label><input value={s.imageModel} onChange={(e) => setS({ ...s, imageModel: e.target.value })} /></div>
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

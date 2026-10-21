import { useCallback, useEffect, useState } from 'react';
import type { AiAssistant, AiAssistantsStatus } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

const NAMES: Record<AiAssistant, string> = { claude: 'Claude Code', codex: 'Codex' };

// Connecting AI assistants: the tg-search skill and the MCP server, so an assistant can set up and run the app from a chat
export function AssistantsSection() {
  const api = getApi();
  const toast = useToast();
  const [status, setStatus] = useState<AiAssistantsStatus | null>(null);
  const [report, setReport] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.assistants.status().then(setStatus, () => {}), [api]);
  useEffect(() => {
    load();
  }, [load]);

  const run = async (fn: () => Promise<string[]>) => {
    setBusy(true);
    try {
      setReport(await fn());
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-engine">
      <section className="settings-card">
        <h2 className="settings-card__title">Управление приложением из ИИ-ассистента</h2>
        <p className="field-hint">
          Подключите Claude Code или Codex — и настраивайте TG Search словами из чата: тематики и лиды, ИИ-движок и модели, агенты,
          помощник групп со сценариями и базами знаний, рассылки, статистика. Ассистент получает навык tg-search (что это за
          приложение и как с ним работать, справочник всех методов API) и MCP-сервер tg-search, через который вызывает приложение.
          Приложение должно быть открыто; всё работает только на этом Mac.
        </p>
      </section>

      {(['claude', 'codex'] as AiAssistant[]).map((a) => {
        const s = status?.[a];
        const done = !!s?.skill && (a === 'codex' ? !!status?.codex.mcp : true) && !!status?.tools;
        return (
          <section key={a} className="settings-card">
            <div className="settings-card__head">
              <h2 className="settings-card__title">{NAMES[a]}</h2>
              <span className={`status-dot${done ? ' status-dot--ok' : ''}`} />
              <span className="settings-card__meta">
                {done ? 'подключено' : 'не подключено'}{s && !s.cli ? ` · ${NAMES[a]} на этом Mac не найден` : ''}
              </span>
              <button type="button" className="btn btn--sm btn--primary" disabled={busy} onClick={() => run(() => api.assistants.install(a))}>
                {done ? 'Обновить' : 'Подключить'}
              </button>
            </div>
            <p className="field-hint">
              {a === 'claude'
                ? 'Навык — в ~/.claude/skills/tg-search, MCP-сервер добавляется командой claude mcp add (для всех проектов). Потом в Claude Code: «настрой в TG Search помощника для моей группы…».'
                : 'Навык — в ~/.codex/skills/tg-search, MCP-сервер — в ~/.codex/config.toml. Потом в Codex: «подключи в TG Search базу знаний из справки Директа…».'}
            </p>
          </section>
        );
      })}

      <section className="settings-card">
        <h2 className="settings-card__title">Другие MCP-клиенты (Cursor, Claude Desktop…)</h2>
        <p className="field-hint">Поставьте команды и добавьте сервер в настройки клиента. ChatGPT пока не подключает локальные MCP-серверы — используйте Codex.</p>
        <div className="helper-chat__opts">
          <button type="button" className="btn btn--sm" disabled={busy} onClick={() => run(() => api.assistants.installTools())}>Поставить команды tgs и tgs-mcp</button>
          {status?.tools && <span className="crm-muted">команда сервера: <code>{status.mcpCommand}</code></span>}
        </div>
        {status && <pre className="assistants-config">{status.mcpConfig}</pre>}
      </section>

      {report.length > 0 && (
        <section className="settings-card">
          <h2 className="settings-card__title">Сделано</h2>
          <ul className="assistants-report">{report.map((r) => <li key={r}>{r}</li>)}</ul>
        </section>
      )}
    </div>
  );
}

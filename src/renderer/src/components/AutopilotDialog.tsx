import { useState } from 'react';
import type { Account, Project } from '../../../shared/types';
import { nextRunText } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { Modal } from './Modal';
import { useToast } from './Toast';

type AutopilotDialogProps = {
  project: Project;
  accounts: Account[];
  onClose: () => void;
  onChange: (p: Project) => void;
};

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <div className="toggle-row">
      <span>{label}</span>
      <button type="button" className={`toggle${on ? ' toggle--on' : ''}`} onClick={onToggle} aria-pressed={on} />
    </div>
  );
}

export function AutopilotDialog({ project, accounts, onClose, onChange }: AutopilotDialogProps) {
  const toast = useToast();
  const [p, setP] = useState(project);
  const ap = p.autopilot;

  const patch = async (patch: Partial<typeof ap>) => {
    try {
      const updated = await getApi().autopilot.set(p.id, patch);
      setP(updated);
      onChange(updated);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const runNow = async () => {
    try {
      await getApi().autopilot.runNow(p.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const projectAccounts = accounts.filter((a) => p.accountIds.includes(a.id));

  return (
    <Modal title="Автопилот проекта" onClose={onClose} wide>
      <Toggle on={ap.enabled} onToggle={() => patch({ enabled: !ap.enabled })} label="Находить и проверять новые сообщения" />
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 16px' }}>
        {ap.enabled
          ? `Ожидает следующей проверки · следующий проход ${nextRunText(ap.nextRunAt)}`
          : 'Автопилот выключен'}
      </p>

      <div className="section-title">Поиск</div>
      <Toggle on={ap.refreshSources} onToggle={() => patch({ refreshSources: !ap.refreshSources })} label="Обновлять источники" />
      <div className="field">
        <label>Проверять сообщения, мин</label>
        <input
          type="number"
          value={ap.scanIntervalMin}
          onChange={(e) => patch({ scanIntervalMin: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <label>Свежесть сообщений</label>
        <select value={ap.freshnessHours} onChange={(e) => patch({ freshnessHours: Number(e.target.value) })}>
          {[6, 12, 24, 48, 72].map((h) => (
            <option key={h} value={h}>{h} ч</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Рабочий список</label>
        <input
          type="number"
          value={ap.workingListSize}
          onChange={(e) => patch({ workingListSize: Number(e.target.value) })}
        />
        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Автоподбор · до {ap.workingListSize}</span>
      </div>

      <div className="section-title">Ответы</div>
      <Toggle on={ap.aiReply} onToggle={() => patch({ aiReply: !ap.aiReply })} label="Отвечать с помощью ИИ" />
      <div className="field">
        <label>Куда отвечать</label>
        <div className="segmented">
          <button
            type="button"
            className={ap.replyTarget === 'dm' ? 'button--active' : ''}
            onClick={() => patch({ replyTarget: 'dm' })}
          >
            Лично
          </button>
          <button
            type="button"
            className={ap.replyTarget === 'chat' ? 'button--active' : ''}
            onClick={() => patch({ replyTarget: 'chat' })}
          >
            В чате
          </button>
        </div>
      </div>
      <Toggle
        on={ap.replyInNewSources}
        onToggle={() => patch({ replyInNewSources: !ap.replyInNewSources })}
        label="Также в новых источниках"
      />
      <Toggle on={ap.joinIfNeeded} onToggle={() => patch({ joinIfNeeded: !ap.joinIfNeeded })} label="Вступать при необходимости" />
      <div className="field">
        <label>Минимальная релевантность, %</label>
        <input type="number" value={ap.minScore} onChange={(e) => patch({ minScore: Number(e.target.value) })} />
      </div>

      {projectAccounts.map((a) => (
        <p key={a.id} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
          {a.firstName ?? a.username}: ЛС: осталось {a.dailyLimit - a.sentToday} из {a.dailyLimit} · общий лимит
        </p>
      ))}

      <button type="button" className="btn btn--primary" style={{ marginTop: 16 }} onClick={runNow}>
        Запустить сейчас
      </button>
    </Modal>
  );
}

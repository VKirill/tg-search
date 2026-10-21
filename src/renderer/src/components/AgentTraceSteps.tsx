import { useState } from 'react';
import type { AgentStep } from '../../../shared/types';
import { agentToolLabel, formatShortTime } from '../utils/format';

type AgentTraceStepsProps = {
  steps: AgentStep[];
  /** Inline link under a message (compact). */
  variant?: 'inline' | 'panel';
  defaultOpen?: boolean;
};

export function AgentTraceSteps({ steps, variant = 'inline', defaultOpen = false }: AgentTraceStepsProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (steps.length === 0) return null;

  const body = (
    <ol className={`agent-trace${variant === 'panel' ? ' agent-trace--panel' : ''}`}>
      {steps.map((s) => (
        <li key={s.id} className={`agent-step${s.ok ? '' : ' agent-step--error'}`}>
          <div className="agent-step__head">
            <span className="agent-step__time">{formatShortTime(s.ts)}</span>
            <span className="agent-step__tool">{agentToolLabel(s.tool)}</span>
            <span className={`agent-step__status${s.ok ? '' : ' agent-step__status--err'}`}>
              {s.ok ? 'ok' : 'ошибка'}
            </span>
          </div>
          {(s.input || s.output) && (
            <details className="agent-step__details">
              <summary>Вход / выход</summary>
              {s.input && <pre className="agent-step__io">{s.input}</pre>}
              {s.output && <pre className="agent-step__io agent-step__io--out">{s.output}</pre>}
            </details>
          )}
        </li>
      ))}
    </ol>
  );

  if (variant === 'panel') {
    return body;
  }

  return (
    <div className="agent-trace-inline">
      <button type="button" className="agent-trace-inline__toggle" onClick={() => setOpen((v) => !v)}>
        {open ? 'Скрыть, что сделал агент' : 'Что сделал агент'}
      </button>
      {open && body}
    </div>
  );
}

/** Steps between the previous message and this outbound auto message. */
export function stepsForAutoTurn(trace: AgentStep[], messageDate: number, prevDate: number): AgentStep[] {
  return trace
    .filter((s) => s.ts > prevDate && s.ts <= messageDate + 500)
    .sort((a, b) => a.ts - b.ts);
}

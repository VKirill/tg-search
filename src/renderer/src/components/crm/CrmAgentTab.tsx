import { useCallback, useEffect, useState } from 'react';
import type { AgentStep } from '../../../../shared/types';
import { AgentTraceSteps } from '../AgentTraceSteps';
import { getApi } from '../../hooks/useApi';

type CrmAgentTabProps = {
  leadId: number;
  toast: (msg: string) => void;
};

export function CrmAgentTab({ leadId, toast }: CrmAgentTabProps) {
  const [trace, setTrace] = useState<AgentStep[]>([]);

  const load = useCallback(async () => {
    try {
      setTrace(await getApi().agent.trace(leadId, 80));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [leadId, toast]);

  useEffect(() => {
    load();
    const off = getApi().onEvent((e) => {
      if (e.type === 'agent:step' && e.step.leadId === leadId) {
        setTrace((prev) => {
          if (prev.some((s) => s.id === e.step.id)) return prev;
          return [e.step, ...prev];
        });
      }
    });
    return off;
  }, [leadId, load]);

  if (trace.length === 0) {
    return <p className="crm-muted">Агент ещё не выполнял инструментов по этому лиду.</p>;
  }

  return (
    <div className="crm-tab crm-tab--agent">
      <p className="crm-muted crm-tab__hint">Журнал инструментов оператора по этому диалогу, в реальном времени.</p>
      <AgentTraceSteps steps={[...trace].sort((a, b) => b.ts - a.ts)} variant="panel" />
    </div>
  );
}

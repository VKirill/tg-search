import { useCallback, useEffect, useState } from 'react';
import type { ClientCard, DealStage, Lead } from '../../../shared/types';
import { DEAL_STAGES, dealStageLabel, displayName } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

type BoardItem = { lead: Lead; card: ClientCard };

type FunnelViewProps = {
  projectId: number | null;
  onOpenLead: (leadId: number) => void;
};

export function FunnelView({ projectId, onOpenLead }: FunnelViewProps) {
  const toast = useToast();
  const [items, setItems] = useState<BoardItem[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await getApi().crm.board(projectId ?? undefined));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  }, [projectId, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const onDrop = async (stage: DealStage, leadId: number) => {
    try {
      await getApi().crm.update(leadId, { stage });
      setItems((prev) =>
        prev.map((it) => (it.lead.id === leadId ? { ...it, card: { ...it.card, stage } } : it)),
      );
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
    setDragId(null);
  };

  const byStage = (stage: DealStage) => items.filter((it) => it.card.stage === stage);

  return (
    <div className="funnel-view">
      <div className="funnel-board">
        {DEAL_STAGES.map((stage) => (
          <div
            key={stage}
            className="funnel-col"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = dragId ?? Number(e.dataTransfer.getData('leadId'));
              if (id) onDrop(stage, id);
            }}
          >
            <div className="funnel-col__head">
              {dealStageLabel(stage)}
              <span className="funnel-col__count">{byStage(stage).length}</span>
            </div>
            <div className="funnel-col__cards">
              {byStage(stage).map(({ lead, card }) => (
                <article
                  key={lead.id}
                  className="funnel-card"
                  draggable
                  onDragStart={() => setDragId(lead.id)}
                  onClick={() => onOpenLead(lead.id)}
                >
                  <div className="funnel-card__name">{displayName(lead)}</div>
                  <div className="funnel-card__task">{card.anamnesis.task || lead.text.slice(0, 60)}</div>
                  <div className="funnel-card__meta">
                    <span>{card.completeness}%</span>
                    <span>{lead.score}%</span>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

import type { AppEvent, ChatMessage, ClientCard, DealStage, Lead } from '../../shared/types';
import type { CrmAi } from '../ai/crm';
import { buildTimeline } from '../ai/crm';
import type { Db } from '../db';

const DEBOUNCE_MS = 20_000;

const STAGE_RANK: Record<DealStage, number> = {
  new: 0,
  contacted: 1,
  discovery: 2,
  brief_ready: 3,
  handed_over: 4,
  proposal: 5,
  won: 6,
  lost: 6,
};

const LOCKED_STAGES = new Set<DealStage>(['proposal', 'won', 'lost']);

export function canAdvanceStage(from: DealStage, to: DealStage): boolean {
  if (LOCKED_STAGES.has(from)) return false;
  if (LOCKED_STAGES.has(to)) return false;
  return STAGE_RANK[to] > STAGE_RANK[from];
}

export function suggestStageFromDialog(lead: Lead, messages: ChatMessage[], hasBrief: boolean): DealStage {
  if (lead.handoff) return 'handed_over';
  if (hasBrief) return 'brief_ready';
  const outbound = messages.some((m) => m.direction === 'out' && m.kind !== 'note');
  const inbound = messages.some((m) => m.direction === 'in');
  if (inbound) return 'discovery';
  if (outbound) return 'contacted';
  return 'new';
}

export function resolveStage(current: DealStage, suggested: DealStage): DealStage {
  if (LOCKED_STAGES.has(current)) return current;
  return canAdvanceStage(current, suggested) ? suggested : current;
}

export interface CrmDeps {
  db: Db;
  crmAi: CrmAi;
  emit: (e: AppEvent) => void;
}

export function createCrm(deps: CrmDeps) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  const handoffHandled = new Set<number>();
  const handoffWork = new Map<number, Promise<void>>();

  function clearTimer(leadId: number) {
    const t = timers.get(leadId);
    if (t) clearTimeout(t);
    timers.delete(leadId);
  }

  async function refresh(leadId: number): Promise<ClientCard> {
    const lead = deps.db.getLead(leadId);
    const project = deps.db.getProject(lead.projectId);
    const card = deps.db.getCard(leadId);
    const messages = deps.db.listMessages(leadId);
    const timeline = buildTimeline(messages, lead);
    const result = await deps.crmAi.analyze(project, lead, timeline, card);

    const hasBrief = Boolean(card.brief.trim() && card.briefUpdatedAt);
    let stage = card.stage;
    const suggested = result.stage ?? suggestStageFromDialog(lead, messages, hasBrief);
    stage = resolveStage(stage, suggested);
    if (lead.handoff && canAdvanceStage(stage, 'handed_over')) stage = 'handed_over';

    const updated = deps.db.updateCard(leadId, {
      summary: result.summary,
      anamnesis: result.anamnesis,
      completeness: result.completeness,
      stage,
    });
    deps.emit({ type: 'crm:update', card: updated });
    return updated;
  }

  async function generateBrief(leadId: number): Promise<ClientCard> {
    const lead = deps.db.getLead(leadId);
    const project = deps.db.getProject(lead.projectId);
    const card = deps.db.getCard(leadId);
    const messages = deps.db.listMessages(leadId);
    const timeline = buildTimeline(messages, lead);
    const brief = await deps.crmAi.writeBrief(project, lead, card, timeline);
    const now = Date.now();
    let stage = card.stage;
    if (canAdvanceStage(stage, 'brief_ready')) stage = 'brief_ready';
    const updated = deps.db.updateCard(leadId, { brief, briefUpdatedAt: now, stage });
    deps.emit({ type: 'crm:update', card: updated });
    return updated;
  }

  function scheduleRefresh(leadId: number) {
    clearTimer(leadId);
    const timer = setTimeout(() => {
      timers.delete(leadId);
      refresh(leadId).catch((err) => console.error('crm refresh', err));
    }, DEBOUNCE_MS);
    timers.set(leadId, timer);
  }

  function onMessage(message: ChatMessage) {
    if (message.kind === 'note') {
      scheduleRefresh(message.leadId);
      return;
    }
    scheduleRefresh(message.leadId);
  }

  function runHandoffPipeline(leadId: number): Promise<void> {
    const existing = handoffWork.get(leadId);
    if (existing) return existing;
    const work = (async () => {
      try {
        await refresh(leadId);
      } catch (err) {
        console.error('crm refresh on handoff', err);
      }
      try {
        await generateBrief(leadId);
      } catch (err) {
        console.error('crm brief on handoff', err);
      }
    })().finally(() => {
      handoffWork.delete(leadId);
    });
    handoffWork.set(leadId, work);
    return work;
  }

  function onLeadUpdate(lead: Lead) {
    if (lead.handoff && !handoffHandled.has(lead.id)) {
      handoffHandled.add(lead.id);
      void runHandoffPipeline(lead.id);
      return;
    }
    if (!lead.handoff) handoffHandled.delete(lead.id);
  }

  function stop() {
    for (const id of timers.keys()) clearTimer(id);
  }

  return { refresh, generateBrief, onMessage, onLeadUpdate, runHandoffPipeline, stop };
}

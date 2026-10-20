import type { Lead, Project, SequenceStep } from '../../shared/types';
import type { ManagerAi } from '../ai/types';
import type { Db } from '../db';
import { draftReply, sendMessage, type OutreachDeps } from './outreach';

export function leadFirstName(lead: Lead): string {
  const name = lead.authorName?.trim();
  if (!name) return '';
  return name.split(/\s+/)[0] ?? '';
}

export function shortRequestQuote(text: string, maxLen = 80): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen + 1);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > 20) return cut.slice(0, lastSpace).trim();
  return t.slice(0, maxLen).trim();
}

export function fillSequenceTemplate(template: string, lead: Lead): string {
  return template
    .replaceAll('{name}', leadFirstName(lead))
    .replaceAll('{request}', shortRequestQuote(lead.text));
}

export function stopChainOnIncoming(db: Db, leadId: number): void {
  const lead = db.getLead(leadId);
  if (lead.nextStepAt == null) return;
  db.updateLead(leadId, { nextStepAt: null });
}

export function maybeStartChainAfterFirstSend(db: Db, leadId: number, now: number): void {
  const lead = db.getLead(leadId);
  if (lead.sequenceStep !== 0) return;
  const project = db.getProject(lead.projectId);
  if (project.sequence.length <= 1) return;
  const delayHours = project.sequence[1].delayHours;
  db.updateLead(leadId, {
    sequenceStep: 1,
    nextStepAt: now + delayHours * 3_600_000,
  });
}

function leadIsSilentAfterLastOut(messages: { direction: 'in' | 'out'; date: number }[]): boolean {
  let lastOutDate = -1;
  for (const m of messages) {
    if (m.direction === 'out') lastOutDate = Math.max(lastOutDate, m.date);
  }
  if (lastOutDate < 0) return false;
  return !messages.some((m) => m.direction === 'in' && m.date > lastOutDate);
}

async function textForStep(
  deps: OutreachDeps & { manager?: ManagerAi },
  project: Project,
  lead: Lead,
  step: SequenceStep,
): Promise<string> {
  if (step.mode === 'template') return fillSequenceTemplate(step.text, lead);
  if (!deps.manager) throw new Error('ИИ-менеджер не настроен');
  const history = deps.db.listMessages(lead.id).map((m) => ({ direction: m.direction, text: m.text }));
  return deps.manager.writeStep(project, lead, step.text, history);
}

export async function firstOutreachText(
  deps: OutreachDeps & { manager?: ManagerAi },
  leadId: number,
  where: 'dm' | 'chat',
): Promise<string> {
  const lead = deps.db.getLead(leadId);
  const project = deps.db.getProject(lead.projectId);
  if (!project.sequence.length) return draftReply(deps, leadId, where);
  return textForStep(deps, project, lead, project.sequence[0]);
}

function isLimiterError(message: string): boolean {
  return message.includes('Дневной лимит') || message.includes('Пауза между отправками');
}

export async function processDueSteps(deps: OutreachDeps & { manager?: ManagerAi }, now: number): Promise<void> {
  for (const project of deps.db.listProjects()) {
    if (!project.sequence.length) continue;
    for (const lead of deps.db.listLeads(project.id, { status: 'replied' })) {
      if (lead.handoff || lead.nextStepAt == null || lead.nextStepAt > now) continue;
      const msgs = deps.db.listMessages(lead.id);
      if (!leadIsSilentAfterLastOut(msgs)) continue;

      const stepIdx = lead.sequenceStep;
      if (stepIdx < 0 || stepIdx >= project.sequence.length) {
        deps.db.updateLead(lead.id, { nextStepAt: null });
        continue;
      }

      const lastOut = [...msgs].reverse().find((m) => m.direction === 'out');
      const where = lastOut?.where ?? project.autopilot.replyTarget;

      try {
        const text = await textForStep(deps, project, lead, project.sequence[stepIdx]);
        await sendMessage(deps, lead.id, text, where, true);
        const nextIdx = stepIdx + 1;
        if (nextIdx < project.sequence.length) {
          deps.db.updateLead(lead.id, {
            sequenceStep: nextIdx,
            nextStepAt: now + project.sequence[nextIdx].delayHours * 3_600_000,
          });
        } else {
          deps.db.updateLead(lead.id, { sequenceStep: nextIdx, nextStepAt: null });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (isLimiterError(error)) continue;
        deps.db.updateLead(lead.id, { nextStepAt: null });
        deps.emit({
          type: 'job',
          projectId: project.id,
          stage: 'Цепочка: шаг не отправлен',
          done: true,
          error,
        });
      }
    }
  }
}

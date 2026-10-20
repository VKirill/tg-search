import type { AppEvent, Lead, Project } from '../../shared/types';
import type { Db } from '../db';
import type { LeadAi, ManagerAi } from '../ai/types';
import type { TelegramEngine } from '../telegram/types';
import { discover, type DiscoveryDeps } from './discovery';
import { scan, type ScannerDeps } from './scanner';
import { sendMessage, type OutreachDeps } from './outreach';
import { firstOutreachText, processDueSteps } from './sequence';
import { canSend } from './limiter';
import { listAuthorizedProjectAccounts } from './accounts';

export interface AutopilotDeps extends DiscoveryDeps, ScannerDeps, OutreachDeps {
  manager?: ManagerAi;
}

type QueueItem = { leadId: number; where: 'dm' | 'chat' };

export interface AutopilotScheduler {
  start(): void;
  stop(): void;
  tick(now?: number): Promise<void>;
  runNow(projectId: number): Promise<void>;
  run(projectId: number): Promise<void>;
}

export function createAutopilot(deps: AutopilotDeps): AutopilotScheduler {
  const running = new Set<number>();
  const queue: QueueItem[] = [];
  const failed = new Set<number>(); // leads whose auto-reply failed; never retried automatically
  let timer: ReturnType<typeof setInterval> | null = null;

  function retireWeakSources(project: Project) {
    for (const s of deps.db.listSources(project.id)) {
      if (s.status !== 'active') continue;
      // checkedLeads counts every qualified message; in a busy chat 1% leads is already a good source.
      if (s.checkedLeads < 100) continue;
      if (s.matchedLeads / s.checkedLeads >= 0.01) continue;
      const updated = deps.db.updateSource(s.id, { status: 'rejected' });
      deps.emit({ type: 'source:update', source: updated });
    }
  }

  function shouldQueueLead(project: Project, lead: Lead): 'dm' | 'chat' | null {
    if (lead.status !== 'new' || lead.score < project.autopilot.minScore) return null;
    const msgs = deps.db.listMessages(lead.id);
    if (msgs.some((m) => m.direction === 'out')) return null;

    const { replyTarget, replyInNewSources } = project.autopilot;
    if (replyTarget === 'dm') {
      if (lead.authorUserId == null) return null;
      return 'dm';
    }
    if (replyInNewSources || replyTarget === 'chat') return 'chat';
    return null;
  }

  function enqueueFromProject(project: Project) {
    if (!project.autopilot.aiReply) return;
    for (const lead of deps.db.listLeads(project.id, { status: 'new' })) {
      const where = shouldQueueLead(project, lead);
      if (!where) continue;
      if (failed.has(lead.id) || queue.some((q) => q.leadId === lead.id)) continue;
      queue.push({ leadId: lead.id, where });
    }
  }

  async function processQueue(now: number) {
    const remaining: QueueItem[] = [];

    for (const item of queue) {
      let lead: Lead;
      let project: Project;
      try {
        lead = deps.db.getLead(item.leadId);
        project = deps.db.getProject(lead.projectId);
      } catch {
        continue; // lead or project was deleted
      }
      // Re-check at send time: the user may have answered, hidden the lead or turned replies off since it was queued.
      if (!project.autopilot.aiReply || lead.status !== 'new') continue;
      if (deps.db.listMessages(lead.id).some((m) => m.direction === 'out')) continue;

      const free = listAuthorizedProjectAccounts(deps.db, project.accountIds).some((a) => canSend(a, now).ok);
      if (!free) {
        remaining.push(item);
        continue;
      }
      try {
        const text = await firstOutreachText(deps, item.leadId, item.where);
        await sendMessage(deps, item.leadId, text, item.where, true);
      } catch (err) {
        // Not retried: a send that failed (closed DMs, no rights in the chat) would fail again on every tick.
        failed.add(item.leadId);
        const error = err instanceof Error ? err.message : String(err);
        deps.emit({ type: 'job', projectId: project.id, stage: 'Автоответ не отправлен', done: true, error });
      }
    }

    queue.length = 0;
    queue.push(...remaining);
  }

  async function run(projectId: number): Promise<void> {
    if (running.has(projectId)) return;
    running.add(projectId);
    try {
      const project = deps.db.getProject(projectId);
      const now = Date.now();

      if (project.autopilot.refreshSources) {
        retireWeakSources(project);
        const active = deps.db.listSources(project.id).filter((s) => s.status === 'active').length;
        if (active < project.autopilot.workingListSize) {
          await discover(deps, projectId);
        }
      }

      await scan(deps, projectId);
      enqueueFromProject(deps.db.getProject(projectId));

      const intervalMs = project.autopilot.scanIntervalMin * 60_000;
      const updated = deps.db.updateProject(projectId, {
        autopilot: { lastRunAt: now, nextRunAt: now + intervalMs },
      });
      deps.emit({ type: 'project:update', project: updated });
    } finally {
      running.delete(projectId);
    }
  }

  async function tick(now = Date.now()): Promise<void> {
    await processDueSteps(deps, now);
    await processQueue(now);
    for (const project of deps.db.listProjects()) {
      const ap = project.autopilot;
      if (!ap.enabled) continue;
      const due = ap.nextRunAt == null || ap.nextRunAt <= now;
      if (!due) continue;
      await run(project.id);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => console.error('autopilot tick', err));
      }, 30_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    runNow(projectId: number) {
      return run(projectId);
    },
    run,
  };
}

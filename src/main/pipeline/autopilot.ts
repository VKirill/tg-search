import type { AppEvent, Lead, Project } from '../../shared/types';
import type { Db } from '../db';
import type { LeadAi } from '../ai/types';
import type { TelegramEngine } from '../telegram/types';
import { discover, type DiscoveryDeps } from './discovery';
import { scan, type ScannerDeps } from './scanner';
import { draftReply, sendMessage, type OutreachDeps } from './outreach';
import { canSend } from './limiter';

export interface AutopilotDeps extends DiscoveryDeps, ScannerDeps, OutreachDeps {}

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
  let timer: ReturnType<typeof setInterval> | null = null;

  function retireWeakSources(project: Project) {
    for (const s of deps.db.listSources(project.id)) {
      if (s.status !== 'active') continue;
      if (s.checkedLeads < 10) continue;
      if (s.matchedLeads / s.checkedLeads >= 0.1) continue;
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
      if (queue.some((q) => q.leadId === lead.id)) continue;
      queue.push({ leadId: lead.id, where });
    }
  }

  async function processQueue(now: number) {
    const usedAccounts = new Set<number>();
    const remaining: QueueItem[] = [];

    for (const item of queue) {
      const lead = deps.db.getLead(item.leadId);
      const project = deps.db.getProject(lead.projectId);
      const accounts = project.accountIds.length
        ? deps.db.listAccounts().filter((a) => project.accountIds.includes(a.id) && a.status === 'authorized')
        : deps.db.listAccounts().filter((a) => a.status === 'authorized');

      const ordered = [...accounts].sort((a, b) => {
        if (a.id === lead.accountId) return -1;
        if (b.id === lead.accountId) return 1;
        return 0;
      });

      let sent = false;
      for (const acc of ordered) {
        if (usedAccounts.has(acc.id)) continue;
        const r = canSend(acc, now);
        if (!r.ok) continue;
        try {
          const text = await draftReply(deps, item.leadId);
          await sendMessage(deps, item.leadId, text, item.where, true);
          usedAccounts.add(acc.id);
          sent = true;
          break;
        } catch {
          // keep in queue on limiter or send failure
        }
      }
      if (!sent) remaining.push(item);
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

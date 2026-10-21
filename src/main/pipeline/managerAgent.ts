import type { MemoryStore } from '../memory/types';
import type { Billing } from '../billing/types';
import type { ChatMessage, ClientCard, Lead, Project } from '../../shared/types';
import type { ManagerAi } from '../ai/types';
import type { Db } from '../db';
import type { TelegramEngine } from '../telegram/types';
import { sendMessage, sendVoiceMessage, type OutreachDeps } from './outreach';
import { canSend } from './limiter';
import { listAuthorizedProjectAccounts } from './accounts';
import type { DialogTurn } from '../ai/types';
import type { ManagerTestResult } from '../../shared/types';
import { createOperator } from '../agent/operator';
import type { Operator, OperatorResult } from '../agent/types';
import type { ExecutorRegistry } from '../executors/types';
import type { AgentDefsApi } from '../agent/defs';
import type { ApprovalsApi } from '../agent/approvals';
import type { SkillsStore } from '../skills';

export interface OrdersHooks {
  handlePostManagerReply(leadId: number, result: ManagerTestResult, lastClientText: string): Promise<void>;
}

export interface ManagerAgentDeps extends OutreachDeps {
  manager: ManagerAi;
  operator?: Operator;
  memory?: MemoryStore; // long-term client memory for the operator's context and tools
  getBilling?: () => Billing | undefined; // lazy: billing is created after the manager agent
  orders?: OrdersHooks & {
    applyManagerIntent?(leadId: number, intent: import('../../shared/types').ManagerOrderIntent): Promise<void>;
    requestPayment?(orderId: number): Promise<import('../../shared/types').Order>;
  };
  dataDir?: string;
  getSettings?: () => import('../../shared/types').Settings;
  executors?: ExecutorRegistry;
  agents?: AgentDefsApi;
  getApprovals?: () => ApprovalsApi | undefined;
  skills?: SkillsStore;
  crm?: {
    refresh(leadId: number): Promise<ClientCard>;
    generateBrief(leadId: number): Promise<ClientCard>;
    runHandoffPipeline(leadId: number): Promise<void>;
  };
}

function buildDialogHistory(lead: Lead, messages: ChatMessage[]): DialogTurn[] {
  const turns: DialogTurn[] = [{ direction: 'in', text: lead.text }];
  for (const m of messages) turns.push({ direction: m.direction, text: m.text });
  return turns;
}

function countAutoRepliesAfterFirstIn(messages: ChatMessage[]): number {
  const firstIn = messages.find((m) => m.direction === 'in');
  if (!firstIn) return 0;
  return messages.filter((m) => m.direction === 'out' && m.auto && m.date >= firstIn.date).length;
}

function leadLine(lead: Lead): string {
  const user = lead.authorUsername ? `@${lead.authorUsername}` : '—';
  const link = lead.link ?? (lead.authorUsername ? `https://t.me/${lead.authorUsername}` : '—');
  return `${lead.authorName ?? 'Без имени'}, ${user}, ${link}`;
}

function isLimiterError(message: string): boolean {
  return message.includes('Дневной лимит') || message.includes('Пауза между отправками');
}

function handoffBodyFromCard(card: ClientCard, briefReady: boolean): string {
  const lines: string[] = [];
  if (card.summary.trim()) lines.push(card.summary.trim());
  const a = card.anamnesis;
  if (a.task.trim()) lines.push(`Задача: ${a.task.trim()}`);
  if (a.goal.trim()) lines.push(`Цель: ${a.goal.trim()}`);
  if (a.budget.trim()) lines.push(`Бюджет: ${a.budget.trim()}`);
  if (a.deadline.trim()) lines.push(`Срок: ${a.deadline.trim()}`);
  if (a.features.length) lines.push(`Функционал: ${a.features.join(', ')}`);
  if (briefReady) lines.push('ТЗ готово в карточке клиента');
  return lines.join('\n');
}

export function createManagerAgent(deps: ManagerAgentDeps) {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let operatorInstance: Operator | null = deps.operator ?? null;

  function clearLeadTimer(leadId: number) {
    const t = timers.get(leadId);
    if (t) clearTimeout(t);
    timers.delete(leadId);
  }

  async function notifyOwner(project: Project, lead: Lead, accountId: number, summary: string, reason: string) {
    const notifyTo = deps.db.getSettings().handoffNotifyTo.trim();
    if (!notifyTo) return;
    const handle = notifyTo.startsWith('@') ? notifyTo : `@${notifyTo}`;
    try {
      const chat = await deps.engine.resolveChat(accountId, handle);
      const header =
        `Передача диалога\n${leadLine(lead)}\nЗапрос: ${lead.text.slice(0, 300)}\nПричина: ${reason}\n\n`;
      await deps.engine.sendToChat(accountId, chat.chatId, header + summary);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.emit({
        type: 'job',
        projectId: project.id,
        stage: 'Уведомление о передаче',
        done: true,
        error,
      });
    }
  }

  async function doHandoff(
    project: Project,
    lead: Lead,
    reason: string,
    bridgeReply: string,
    history: DialogTurn[],
    summaryOverride?: string,
  ) {
    const updated = deps.db.updateLead(lead.id, { handoff: true, handoffReason: reason });
    deps.emit({ type: 'lead:update', lead: updated });

    if (bridgeReply.trim()) {
      await sendMessage(deps, lead.id, bridgeReply.trim(), 'dm', true);
    }

    const accountId = updated.accountId ?? listAuthorizedProjectAccounts(deps.db, project.accountIds)[0]?.id;
    if (accountId == null) return;

    let briefReady = false;
    if (deps.crm) {
      await deps.crm.runHandoffPipeline(lead.id);
      const after = deps.db.getCard(lead.id);
      briefReady = Boolean(after.brief.trim() && after.briefUpdatedAt);
    }

    const card = deps.db.getCard(lead.id);
    const summary =
      summaryOverride?.trim() ||
      (card.summary.trim() || card.anamnesis.task.trim()
        ? handoffBodyFromCard(card, briefReady)
        : history.slice(-3).map((t) => `${t.direction === 'in' ? 'Лид' : 'Мы'}: ${t.text}`).join('\n'));
    await notifyOwner(project, updated, accountId, summary, reason);
  }

  function getOperator(): Operator {
    if (!operatorInstance) {
      operatorInstance = createOperator({
        db: deps.db,
        engine: deps.engine,
        ai: deps.ai,
        speech: deps.speech,
        emit: deps.emit,
        getSettings: deps.getSettings ?? (() => deps.db.getSettings()),
        manager: deps.manager,
        dataDir: deps.dataDir,
        executors: deps.executors,
        memory: deps.memory,
        billing: deps.getBilling?.(),
        orders: deps.orders?.applyManagerIntent
          ? {
              applyManagerIntent: deps.orders.applyManagerIntent.bind(deps.orders),
              requestPayment: deps.orders.requestPayment!,
            }
          : undefined,
        skills: deps.skills,
        handoff: {
          doHandoff: async (leadId, reason, summary, bridgeReply) => {
            const l = deps.db.getLead(leadId);
            const p = deps.db.getProject(l.projectId);
            const msgs = deps.db.listMessages(leadId);
            await doHandoff(p, l, reason, bridgeReply, buildDialogHistory(l, msgs), summary);
          },
        },
        agents: deps.agents,
        getApprovals: deps.getApprovals,
      });
    }
    return operatorInstance;
  }

  function operatorToManagerResult(op: OperatorResult): ManagerTestResult {
    return {
      reply: op.reply ?? '',
      handoff: op.handoff,
      reason: op.reason,
      ...(op.order !== undefined ? { order: op.order } : {}),
    };
  }

  function replyAlreadySent(op: OperatorResult): boolean {
    return op.steps.some((s) => s.tool === 'reply' && s.ok);
  }

  function handoffAlreadyDone(op: OperatorResult): boolean {
    return op.steps.some((s) => s.tool === 'handoff' && s.ok);
  }

  async function runReply(leadId: number) {
    timers.delete(leadId);
    let lead: Lead;
    let project: Project;
    try {
      lead = deps.db.getLead(leadId);
      project = deps.db.getProject(lead.projectId);
    } catch {
      return;
    }
    if (!project.manager.enabled || lead.handoff) return;

    const messages = deps.db.listMessages(leadId);
    const history = buildDialogHistory(lead, messages);

    if (countAutoRepliesAfterFirstIn(messages) >= project.manager.maxReplies) {
      await doHandoff(project, lead, 'Лимит ответов ИИ', '', history);
      return;
    }

    try {
      const op = await getOperator().turn(leadId);
      const result = operatorToManagerResult(op);
      if (result.handoff) {
        if (!handoffAlreadyDone(op)) {
          await doHandoff(project, lead, result.reason || 'Передача менеджеру', result.reply, history);
        }
        return;
      }

      const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
      if (deps.orders) {
        await deps.orders.handlePostManagerReply(leadId, result, lastIn?.text ?? '');
      }

      if (!result.reply.trim() || replyAlreadySent(op)) return;

      const now = Date.now();
      const accountId = lead.accountId ?? listAuthorizedProjectAccounts(deps.db, project.accountIds)[0]?.id;
      if (accountId != null) {
        const account = deps.db.getAccount(accountId);
        const gate = canSend(account, now);
        if (!gate.ok) {
          const waitMs = gate.reason === 'pause' ? gate.waitMs ?? project.manager.replyDelaySec * 1000 : 60_000;
          const timer = setTimeout(() => {
            runReply(leadId).catch((err) => console.error('manager retry', err));
          }, waitMs);
          timers.set(leadId, timer);
          return;
        }
      }

      const mirrorVoice =
        project.manager.voiceReplies === 'mirror' && lastIn?.kind === 'voice' && deps.speech;
      if (mirrorVoice) {
        await sendVoiceMessage(deps, leadId, result.reply.trim(), 'dm', true);
      } else {
        await sendMessage(deps, leadId, result.reply.trim(), 'dm', true);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (isLimiterError(error)) {
        const project = deps.db.getProject(deps.db.getLead(leadId).projectId);
        const waitMs = project.manager.replyDelaySec * 1000;
        const timer = setTimeout(() => {
          runReply(leadId).catch((e) => console.error('manager retry', e));
        }, waitMs);
        timers.set(leadId, timer);
        return;
      }
      deps.emit({
        type: 'job',
        projectId: project.id,
        stage: 'Ответ ИИ-менеджера',
        done: true,
        error,
      });
    }
  }

  function onIncoming(leadId: number) {
    const lead = deps.db.getLead(leadId);
    const project = deps.db.getProject(lead.projectId);
    if (!project.manager.enabled || lead.handoff) return;

    clearLeadTimer(leadId);
    const delayMs = project.manager.replyDelaySec * 1000;
    const timer = setTimeout(() => {
      runReply(leadId).catch((err) => console.error('manager reply', err));
    }, delayMs);
    timers.set(leadId, timer);
  }

  function stop() {
    for (const id of timers.keys()) clearLeadTimer(id);
  }

  return { onIncoming, stop, getOperator };
}

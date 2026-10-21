import type { AgentDef, AgentStep, ChatMessage, Lead, ManagerSettings, Project } from '../../shared/types';
import type { ManagerAi } from '../ai/types';
import type { Billing } from '../billing/types';
import type { ExecutorRegistry } from '../executors/types';
import type { MemoryStore } from '../memory/types';
import type { OutreachDeps } from '../pipeline/outreach';
import { managerServicesContext } from '../ai/manager';
import { agentChatCompletion, type AgentChatMessage, type AgentCompletionResult } from './llm';
import { buildClientContext, catalogContext, projectManagerPrompt } from './context';
import { insertAgentStep } from './store';
import { ensureAgentSchema } from './schema';
import { buildAgentTools, freshTurnState, toolsToLlmDefs, type HandoffActions, type OrderActions } from './tools';
import type { Operator, OperatorResult, OperatorTurnOptions } from './types';
import type { AgentDefsApi } from './defs';
import type { ApprovalsApi } from './approvals';
import { gateToolCall } from './approvals';
import { resolveAgentModel } from './model';
import { createDelegateTool } from './tools/delegate';
import { upsellBlock } from './upsell';
import { freeClientBlock, isFreeLead } from '../trusted';
import { CHAT_STYLE, HONESTY_RULE } from './style';
import type { SkillsStore } from '../skills';

const MAX_TOOL_ROUNDS = 8;
const TURN_COST_CAP_USD = 0.15;
const OPERATOR_RULES =
  'Правила: один вопрос за раз; не выдумывай цены и условия, которых нет в оффере и каталоге. ' +
  'Завершай ход инструментом reply с текстом для клиента. Цену называй только внутри вилки услуги. ' +
  'Клиенты редко дают бриф — формулируй допущения. Перед использованием фото клиента спроси согласие. ' +
  'Если клиент хочет регулярную помощь, ассистента на месяц или много поручений — назови тариф подписки из каталога ' +
  '(цена, квота поручений, что входит) и предложи оформить (инструмент offer_subscription после согласия).';


export interface OperatorDeps extends OutreachDeps {
  getSettings: () => import('../../shared/types').Settings;
  manager: ManagerAi;
  memory?: MemoryStore;
  billing?: Billing;
  executors?: ExecutorRegistry;
  orders?: OrderActions;
  handoff?: HandoffActions;
  dataDir?: string;
  agents?: AgentDefsApi;
  approvals?: ApprovalsApi;
  getApprovals?: () => ApprovalsApi | undefined;
  skills?: SkillsStore;
  /** Test hook: replace the operator LLM */
  complete?: (
    messages: AgentChatMessage[],
    tools: ReturnType<typeof toolsToLlmDefs>,
    mgr?: ManagerSettings,
    agent?: AgentDef,
  ) => Promise<AgentCompletionResult>;
}

function buildDialogHistory(lead: Lead, messages: ChatMessage[]) {
  // a personal-chat lead (a trusted contact) has no publication text
  const turns: { direction: 'in' | 'out'; text: string }[] = lead.text.trim() ? [{ direction: 'in', text: lead.text }] : [];
  for (const m of messages) turns.push({ direction: m.direction, text: m.text });
  return turns;
}

function lastClientText(lead: Lead, messages: ChatMessage[]): string {
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  return lastIn?.text ?? lead.text;
}

function billingPlansText(billing?: Billing, clientId?: number | null): string {
  if (!billing) return '';
  const lines = billing
    .plans()
    .filter((p) => p.enabled)
    .map((p) => `id=${p.id}: ${p.name}, ${p.priceMonth} ₽/мес, ${p.tasksPerMonth} поручений — ${p.description}`);
  const st = clientId != null ? billing.status(clientId) : null;
  if (st?.subscription && st.plan) {
    lines.push(`Текущая подписка клиента: ${st.plan.name}, статус ${st.subscription.status}, дней осталось ${st.daysLeft ?? '—'}, поручений осталось ${st.tasksLeft ?? '—'}`);
  }
  return lines.join('\n');
}

function projectContextBlock(project: Project, owner: string): string {
  const materials = project.materials.map((m) => m.text?.trim()).filter(Boolean).join('\n\n') || '—';
  return `Контекст проекта «${project.name}»: задача ${project.task}; кого ищем: ${project.target}; оффер: ${project.offer}; материалы:\n${materials}`.replaceAll(
    '{owner}',
    owner || 'владельца',
  );
}

export function createOperator(deps: OperatorDeps): Operator {
  ensureAgentSchema(deps.db.raw);

  async function runWithFallback(
    project: Project,
    lead: Lead,
    history: { direction: 'in' | 'out'; text: string }[],
    mgr: ManagerSettings,
    card: import('../../shared/types').ClientCard | undefined,
    dryRun: boolean,
    continuation?: OperatorTurnOptions['approvalContinuation'],
    systemNote?: string,
  ): Promise<OperatorResult> {
    let lastErr: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        return await runToolLoop(project, lead, history, mgr, card, dryRun, continuation, systemNote);
      } catch (e) {
        lastErr = e;
        console.error('operator turn failed', e);
        try {
          const step = insertAgentStep(deps.db, {
            leadId: lead.id, ts: Date.now(), tool: 'operator_error', input: '',
            output: e instanceof Error ? e.message : String(e), ok: false,
          });
          deps.emit({ type: 'agent:step', step });
        } catch (traceErr) {
          console.error('agent trace', traceErr);
        }
      }
    }
    const fallback = await deps.manager.reply(project, lead, history, mgr, card);
    return {
      reply: fallback.reply,
      handoff: fallback.handoff,
      reason: fallback.reason,
      steps: [],
      order: fallback.order,
    };
  }

  async function runToolLoop(
    project: Project,
    lead: Lead,
    history: { direction: 'in' | 'out'; text: string }[],
    mgr: ManagerSettings,
    card: import('../../shared/types').ClientCard | undefined,
    dryRun: boolean,
    continuation?: OperatorTurnOptions['approvalContinuation'],
    systemNote?: string,
  ): Promise<OperatorResult> {
    const owner = deps.getSettings().ownerName;
    const messages = deps.db.listMessages(lead.id);
    const lastIn = lastClientText(lead, messages);
    const clientId = lead.clientId ?? deps.memory?.clientForLead(lead.id)?.id ?? null;

    const catalog = catalogContext(deps.db, lead.id, billingPlansText(deps.billing, clientId));
    const clientCtx = buildClientContext(deps.db, lead, lastIn, deps.memory, card);

    const skillsBlock = deps.skills?.formatAvailableBlock() ?? '';
    const skillHint = deps.skills ? await deps.skills.hintForClientMessage(lastIn) : '';
    const skillsCtx = [skillsBlock, skillHint].filter(Boolean).join('\n\n');
    const upsell = isFreeLead(deps.db, lead) ? freeClientBlock(owner) : upsellBlock(deps.db, lead.id);
    const skillsPart = [skillsCtx, upsell].filter(Boolean).map((b) => `${b}\n\n`).join('');

    const agentName = (project.agent || 'manager').trim() || 'manager';
    let agentDef: AgentDef | undefined;
    let maxRounds = MAX_TOOL_ROUNDS;
    let temperature = 0.3;
    let modelOverride = undefined as ReturnType<typeof resolveAgentModel>;

    let system: string;
    if (deps.agents) {
      agentDef = deps.agents.get(agentName);
      maxRounds = agentDef.steps;
      temperature = agentDef.temperature ?? 0.3;
      modelOverride = resolveAgentModel(agentDef.model, deps.getSettings());
      const companyRules = deps.agents.rules();
      const identity = `${CHAT_STYLE}\n\n${HONESTY_RULE.replaceAll('{owner}', owner || 'владельца')}`;
      system = `${companyRules}\n\n${identity}\n\n${agentDef.prompt}\n\n${projectContextBlock(project, owner)}\n\n${catalog}\n\n${skillsPart}Контекст клиента:\n${clientCtx}`;
    } else {
      const persona = projectManagerPrompt(project, mgr.prompt, owner);
      const rules = `${OPERATOR_RULES}\n\n${CHAT_STYLE}\n\n${HONESTY_RULE.replaceAll('{owner}', owner || 'владельца')}`;
      system = `${persona}\n\n${rules}\n\n${catalog}\n\n${skillsPart}Контекст клиента:\n${clientCtx}`;
    }

    const turnState = freshTurnState();
    const toolHost = { ...deps, turnState };
    let tools = buildAgentTools(toolHost);
    const approvalsApi = deps.getApprovals?.() ?? deps.approvals;
    if (deps.agents && approvalsApi && agentDef?.mode === 'primary') {
      tools.push(
        createDelegateTool({
          ...toolHost,
          agents: deps.agents,
          approvals: approvalsApi,
          primaryAgent: agentName,
          clientContext: clientCtx,
        }),
      );
    }
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const llmTools = toolsToLlmDefs(tools);

    const chatMessages: AgentChatMessage[] = [
      { role: 'system', content: system },
      ...history.map((t) => ({
        role: t.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: t.text,
      })),
    ];
    if (systemNote) chatMessages.push({ role: 'user', content: systemNote });
    if (continuation) {
      chatMessages.push({
        role: 'user',
        content: `Система: согласованное действие «${continuation.tool}» выполнено. Результат:\n${continuation.output}\n\nПродолжи диалог с клиентом.`,
      });
    }

    const steps: AgentStep[] = [];
    let turnCost = 0;
    const ctx = { leadId: lead.id, clientId, dryRun };

    const complete =
      deps.complete ??
      ((msgs, defs, m, agent) =>
        agentChatCompletion(
          deps.getSettings,
          msgs,
          defs,
          m,
          agent ? resolveAgentModel(agent.model, deps.getSettings()) : modelOverride,
          agent?.temperature ?? temperature,
        ));

    let exhausted = false;
    for (let round = 0; round < maxRounds; round++) {
      if (turnCost >= TURN_COST_CAP_USD) break;
      const result = await complete(chatMessages, llmTools, mgr, agentDef);
      turnCost += result.usageCostUsd;
      const msg = result.message;

      if (!msg.tool_calls?.length) {
        if (msg.content?.trim() && !turnState.replyUsed) {
          turnState.replyText = msg.content.trim();
        }
        break;
      }

      chatMessages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });

      for (const tc of msg.tool_calls) {
        const tool = toolMap.get(tc.name);
        let output = 'Ошибка: неизвестный инструмент';
        let ok = false;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments) as Record<string, unknown>;
        } catch {
          output = 'Ошибка: невалидные аргументы JSON';
        }
        if (tool) {
          const skipPerm = (ctx as { skipPermission?: boolean }).skipPermission;
          if (deps.agents && approvalsApi && agentDef && !skipPerm) {
            const gate = gateToolCall(agentName, agentDef, tc.name, args, ctx, {
              db: deps.db,
              agents: deps.agents,
              approvals: approvalsApi,
            });
            if (gate.blocked) {
              output = gate.output;
              ok = gate.ok;
            } else {
              try {
                output = await tool.run(args, ctx);
                ok = !output.startsWith('Ошибка:');
              } catch (e) {
                output = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
              }
            }
          } else {
            try {
              output = await tool.run(args, ctx);
              ok = !output.startsWith('Ошибка:');
            } catch (e) {
              output = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
        }

        const step = insertAgentStep(deps.db, {
          leadId: lead.id,
          ts: Date.now(),
          tool: tc.name,
          input: JSON.stringify(args),
          output,
          ok,
        });
        steps.push(step);
        deps.emit({ type: 'agent:step', step });

        chatMessages.push({ role: 'tool', tool_call_id: tc.id, content: output });
      }

      if (turnState.replyUsed || turnState.handoff) break;
      if (round === maxRounds - 1) exhausted = !turnState.replyUsed && !turnState.handoff;
    }

    if (!turnState.replyText && agentDef && exhausted) {
      const summary = await complete(
        [
          ...chatMessages,
          { role: 'user', content: 'Кратко перечисли, что осталось сделать (2–4 предложения) и как продолжишь с клиентом.' },
        ],
        [],
        mgr,
        agentDef,
      );
      if (summary.message.content?.trim()) turnState.replyText = summary.message.content.trim();
    }

    return {
      reply: turnState.replyText,
      handoff: turnState.handoff,
      reason: turnState.handoffReason,
      steps,
      order: turnState.orderIntent,
    };
  }

  return {
    async turn(leadId: number, opts?: OperatorTurnOptions): Promise<OperatorResult> {
      const dryRun = !!opts?.dryRun;
      const lead = opts?.leadOverride ?? deps.db.getLead(leadId);
      const project = opts?.projectOverride ?? deps.db.getProject(lead.projectId);
      const mgr = opts?.settings ? { ...project.manager, ...opts.settings } : project.manager;
      const messages = lead.id ? deps.db.listMessages(lead.id) : [];
      const history = buildDialogHistory(lead, messages);
      let card;
      try {
        if (lead.id) card = deps.db.getCard(lead.id);
      } catch {
        card = undefined;
      }
      const servicesCtx = managerServicesContext(deps.db.listServices(), lead.id ? deps.db.listOrders(lead.id) : []);
      const mgrWithCatalog = { ...mgr, prompt: `${mgr.prompt}\n\n${servicesCtx}` };
      return runWithFallback(project, lead, history, mgrWithCatalog, card, dryRun, opts?.approvalContinuation, opts?.systemNote);
    },
  };
}

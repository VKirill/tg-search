import type { AgentStep, ChatMessage, Lead, ManagerSettings, Project } from '../../shared/types';
import type { ManagerAi } from '../ai/types';
import type { Billing } from '../billing/types';
import type { ExecutorRegistry } from '../executors/types';
import type { MemoryStore } from '../memory/types';
import type { OutreachDeps } from '../pipeline/outreach';
import { managerServicesContext } from '../ai/manager';
import { agentChatCompletion, type AgentChatMessage, type AgentCompletionResult } from './llm';
import { buildClientContext, catalogContext, projectManagerPrompt } from './context';
import { insertAgentStep } from './store';
import { buildAgentTools, freshTurnState, toolsToLlmDefs, type HandoffActions, type OrderActions } from './tools';
import type { Operator, OperatorResult, OperatorTurnOptions } from './types';

const MAX_TOOL_ROUNDS = 8;
const TURN_COST_CAP_USD = 0.15;
const OPERATOR_RULES =
  'Правила: пиши как живой человек на языке собеседника; 1–4 коротких предложения; один вопрос за раз; ' +
  'не выдумывай цены и условия, которых нет в оффере и каталоге; ты — помощник человека по имени {owner} (в тексте склоняй имя: «помощник Кирилла»). ' +
  'На вопросы «ты бот?», «ты человек?», «кто ты?» отвечай только, что ты его помощник и помогаешь с задачей; ' +
  'не называй себя живым человеком и не говори «я не бот». ' +
  'Завершай ход инструментом reply с текстом для клиента. Цену называй только внутри вилки услуги. ' +
  'Клиенты редко дают бриф — формулируй допущения. Перед использованием фото клиента спроси согласие.';

export interface OperatorDeps extends OutreachDeps {
  getSettings: () => import('../../shared/types').Settings;
  manager: ManagerAi;
  memory?: MemoryStore;
  billing?: Billing;
  executors?: ExecutorRegistry;
  orders?: OrderActions;
  handoff?: HandoffActions;
  dataDir?: string;
  /** Test hook: replace the operator LLM */
  complete?: (
    messages: AgentChatMessage[],
    tools: ReturnType<typeof toolsToLlmDefs>,
    mgr?: ManagerSettings,
  ) => Promise<AgentCompletionResult>;
}

function buildDialogHistory(lead: Lead, messages: ChatMessage[]) {
  const turns: { direction: 'in' | 'out'; text: string }[] = [{ direction: 'in', text: lead.text }];
  for (const m of messages) turns.push({ direction: m.direction, text: m.text });
  return turns;
}

function lastClientText(lead: Lead, messages: ChatMessage[]): string {
  const lastIn = [...messages].reverse().find((m) => m.direction === 'in');
  return lastIn?.text ?? lead.text;
}

function billingPlansText(billing?: Billing, clientId?: number | null): string {
  if (!billing || clientId == null) return '';
  const st = billing.status(clientId);
  if (!st.plan) return '';
  return `id=${st.plan.id}: ${st.plan.name}, ${st.plan.priceMonth} ₽/мес, ${st.plan.tasksPerMonth} поручений — ${st.plan.description}`;
}

export function createOperator(deps: OperatorDeps): Operator {
  async function runWithFallback(
    project: Project,
    lead: Lead,
    history: { direction: 'in' | 'out'; text: string }[],
    mgr: ManagerSettings,
    card: import('../../shared/types').ClientCard | undefined,
    dryRun: boolean,
  ): Promise<OperatorResult> {
    let lastErr: unknown;
    for (let i = 0; i < 2; i++) {
      try {
        return await runToolLoop(project, lead, history, mgr, card, dryRun);
      } catch (e) {
        lastErr = e;
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
  ): Promise<OperatorResult> {
    const owner = deps.getSettings().ownerName;
    const messages = deps.db.listMessages(lead.id);
    const lastIn = lastClientText(lead, messages);
    const clientId = lead.clientId ?? deps.memory?.clientForLead(lead.id)?.id ?? null;

    const persona = projectManagerPrompt(project, mgr.prompt, owner);
    const rules = OPERATOR_RULES.replaceAll('{owner}', owner || 'владельца');
    const catalog = catalogContext(deps.db, lead.id, billingPlansText(deps.billing, clientId));
    const clientCtx = buildClientContext(deps.db, lead, lastIn, deps.memory, card);

    const system = `${persona}\n\n${rules}\n\n${catalog}\n\nКонтекст клиента:\n${clientCtx}`;

    const turnState = freshTurnState();
    const toolHost = { ...deps, turnState };
    const tools = buildAgentTools(toolHost);
    const toolMap = new Map(tools.map((t) => [t.name, t]));
    const llmTools = toolsToLlmDefs(tools);

    const chatMessages: AgentChatMessage[] = [
      { role: 'system', content: system },
      ...history.map((t) => ({
        role: t.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: t.text,
      })),
    ];

    const steps: AgentStep[] = [];
    let turnCost = 0;
    const ctx = { leadId: lead.id, clientId, dryRun };

    const complete =
      deps.complete ??
      ((msgs, defs, m) => agentChatCompletion(deps.getSettings, msgs, defs, m));

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (turnCost >= TURN_COST_CAP_USD) break;
      const result = await complete(chatMessages, llmTools, mgr);
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
          try {
            output = await tool.run(args, ctx);
            ok = !output.startsWith('Ошибка:');
          } catch (e) {
            output = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
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
      return runWithFallback(project, lead, history, mgrWithCatalog, card, dryRun);
    },
  };
}

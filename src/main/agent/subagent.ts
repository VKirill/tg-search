import type { AgentDef, AgentStep, AppEvent } from '../../shared/types';
import { agentChatCompletion, type AgentChatMessage, type AgentCompletionResult } from './llm';
import { resolveAgentModel } from './model';
import { gateToolCall, type ApprovalsApi } from './approvals';
import { resolveToolPermission } from './permissions';
import { buildAgentTools, freshTurnState, toolsToLlmDefs } from './tools';
import type { ToolHostDeps } from './tools/deps';
import type { AgentDefsApi } from './defs';
import { insertAgentStep } from './store';
import type { Db } from '../db';

export interface SubagentRunInput {
  agentName: string;
  task: string;
  context: string;
  leadId: number;
  clientId: number | null;
  host: ToolHostDeps;
  agents: AgentDefsApi;
  approvals: ApprovalsApi;
  db: Db;
  emit: (e: AppEvent) => void;
  complete?: (
    messages: AgentChatMessage[],
    tools: ReturnType<typeof toolsToLlmDefs>,
    agent: AgentDef,
  ) => Promise<AgentCompletionResult>;
  includeDelegate?: boolean;
}

export async function runSubagentTurn(input: SubagentRunInput): Promise<{ text: string; steps: AgentStep[] }> {
  const agent = input.agents.get(input.agentName);
  if (agent.mode !== 'subagent') {
    throw new Error(`Агент «${input.agentName}» не является subagent`);
  }
  const rules = input.agents.rules();
  const system = `${rules}\n\n${agent.prompt}\n\nКонтекст:\n${input.context}\n\nЗадача:\n${input.task}`;
  const turnState = freshTurnState();
  const toolHost = { ...input.host, turnState };
  let tools = buildAgentTools(toolHost);
  if (!input.includeDelegate) {
    tools = tools.filter((t) => t.name !== 'delegate');
  }
  tools = tools.filter((t) => resolveToolPermission(agent.permission, t.name) !== 'deny');
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const llmTools = toolsToLlmDefs(tools);
  const modelOverride = resolveAgentModel(agent.model, input.host.getSettings());
  const temperature = agent.temperature ?? 0.3;

  const chatMessages: AgentChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: input.task },
  ];

  const steps: AgentStep[] = [];
  const maxRounds = agent.steps;
  const prefix = `${input.agentName}:`;

  const complete =
    input.complete ??
    ((msgs, defs, a) =>
      agentChatCompletion(
        input.host.getSettings,
        msgs,
        defs,
        undefined,
        resolveAgentModel(a.model, input.host.getSettings()),
        a.temperature ?? 0.3,
      ));

  const ctx = { leadId: input.leadId, clientId: input.clientId, dryRun: false, subagent: true };

  for (let round = 0; round < maxRounds; round++) {
    const result = await complete(chatMessages, llmTools, agent);
    const msg = result.message;
    if (!msg.tool_calls?.length) {
      if (msg.content?.trim()) turnState.replyText = msg.content.trim();
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
        const gate = gateToolCall(input.agentName, agent, tc.name, args, ctx, {
          db: input.db,
          agents: input.agents,
          approvals: input.approvals,
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
      }

      const step = insertAgentStep(input.db, {
        leadId: input.leadId,
        ts: Date.now(),
        tool: `${prefix}${tc.name}`,
        input: JSON.stringify(args),
        output,
        ok,
      });
      steps.push(step);
      input.emit({ type: 'agent:step', step });
      chatMessages.push({ role: 'tool', tool_call_id: tc.id, content: output });
    }

    if (turnState.replyUsed) break;
  }

  if (!turnState.replyText && maxRounds > 0) {
    const summary = await complete(
      [
        ...chatMessages,
        {
          role: 'user',
          content: 'Кратко перечисли, что удалось сделать и что осталось (2–4 предложения).',
        },
      ],
      [],
      agent,
    );
    if (summary.message.content?.trim()) turnState.replyText = summary.message.content.trim();
  }

  return { text: turnState.replyText ?? '', steps };
}

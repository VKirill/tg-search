import type { AgentTool } from '../types';
import type { ToolHostDeps } from './deps';
import { createReplyTool } from './reply';
import { createHandoffTool } from './handoff';
import { createMemoryTools } from './memory';
import { createOrderTools } from './orders';
import { createBillingTools } from './billing';
import { createSendAssetTool } from './asset';
import { createWebTools } from './web';
import { createRunTaskTool } from './runTask';
import { createOfferAddonTool } from './upsell';
import { createSkillsTool } from './skills';

export function buildAgentTools(deps: ToolHostDeps): AgentTool[] {
  const tools: AgentTool[] = [
    createReplyTool(deps),
    createHandoffTool(deps),
    ...createMemoryTools(deps),
    createSendAssetTool(deps),
    ...createOrderTools(deps),
    ...createBillingTools(deps),
    createRunTaskTool(deps),
    createOfferAddonTool(deps),
    ...createWebTools(deps),
  ];
  if (deps.skills) tools.push(createSkillsTool(deps));
  return tools;
}

export function toolsToLlmDefs(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export { freshTurnState } from './state';
export type { ToolHostDeps, OrderActions, HandoffActions } from './deps';

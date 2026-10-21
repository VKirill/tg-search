// Contract of the operator agent: a tool-calling loop over an OpenAI-compatible API. Implemented in ./operator.ts.
// Rules live inside tools (price range, limiter, single invoice, photo consent, subscription quota), not in the prompt.

import type { AgentStep, Lead, ManagerOrderIntent, ManagerSettings, Project } from '../../shared/types';

export interface ToolContext {
  leadId: number;
  clientId: number | null;
  dryRun: boolean; // sandbox: tools describe what they would do and change nothing
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema of the arguments
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>; // result text for the model
}

export interface OperatorResult {
  reply: string | null; // what was sent (or would be sent) to the client
  handoff: boolean;
  reason: string;
  steps: AgentStep[];
  order?: ManagerOrderIntent | null;
}

export interface OperatorTurnOptions {
  dryRun?: boolean;
  settings?: ManagerSettings;
  leadOverride?: Lead;
  projectOverride?: Project;
}

export interface Operator {
  turn(leadId: number, opts?: OperatorTurnOptions): Promise<OperatorResult>;
}

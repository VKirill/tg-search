// Contract of the operator agent: a tool-calling loop over an OpenAI-compatible API. Implemented in ./operator.ts.
// Rules live inside tools (price range, limiter, single invoice, photo consent, subscription quota), not in the prompt.

import type { AgentStep, ManagerSettings } from '../../shared/types';

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
}

export interface Operator {
  turn(leadId: number, opts?: { dryRun?: boolean; settings?: ManagerSettings }): Promise<OperatorResult>;
}

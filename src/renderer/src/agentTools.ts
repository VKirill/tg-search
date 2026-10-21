import type { ToolPermission } from '../../shared/types';

/** Tool names shown in the agent permission editor (contract tools). */
export const KNOWN_AGENT_TOOLS = [
  'reply',
  'handoff',
  'search_memory',
  'remember',
  'send_asset',
  'create_or_update_order',
  'preview',
  'request_payment',
  'order_status',
  'billing_status',
  'offer_subscription',
  'check_payment',
  'run_task',
  'web_search',
  'fetch_url',
  'load_skill',
  'delegate',
] as const;

export const TOOL_PERMISSIONS: ToolPermission[] = ['allow', 'ask', 'deny'];

export function toolPermissionLabel(p: ToolPermission): string {
  const map: Record<ToolPermission, string> = {
    allow: 'Разрешить',
    ask: 'Спросить',
    deny: 'Запретить',
  };
  return map[p];
}

export function agentModelLabel(model: string): string {
  if (!model || model === 'main' || model === 'glm') return 'Основная';
  if (model === 'fast') return 'Быстрая';
  if (model === 'vision' || model === 'gemini') return 'Со зрением';
  if (model === 'smart' || model === 'deepseek') return 'Умная';
  return model;
}

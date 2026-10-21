import type { AgentDef, ToolPermission } from '../../shared/types';
import type { Db } from '../db';

function globMatch(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*')) return pattern === name;
  const parts = pattern.split('*');
  if (parts.length === 2) {
    const [pre, suf] = parts;
    return name.startsWith(pre) && name.endsWith(suf);
  }
  return pattern === name;
}

/**
 * An exact tool name beats any glob, whatever the order in the file («"*": deny» after «make_xlsx: allow» used to deny
 * everything); among globs the last match wins; default allow when nothing matches.
 */
export function resolveToolPermission(permission: Record<string, ToolPermission>, toolName: string): ToolPermission {
  const entries = Object.entries(permission);
  if (!entries.length) return 'allow';
  if (toolName in permission) return permission[toolName];
  let result: ToolPermission = 'allow';
  for (const [pattern, perm] of entries) {
    if (globMatch(pattern, toolName)) result = perm;
  }
  return result;
}

function orderAmount(db: Db, args: Record<string, unknown>): number | null {
  const orderId = Number(args.orderId);
  if (!Number.isFinite(orderId)) return null;
  try {
    const order = db.getOrder(orderId);
    if (order.price != null) return order.price;
    const service = db.getService(order.serviceId);
    return service.priceMin;
  } catch {
    return null;
  }
}

/** Manager default: request_payment ask only above 3000 ₽ when permission is ask. */
export function effectiveToolPermission(
  agent: AgentDef,
  toolName: string,
  args: Record<string, unknown>,
  db: Db,
): ToolPermission {
  const base = resolveToolPermission(agent.permission, toolName);
  if (toolName === 'request_payment' && base === 'ask') {
    const amount = orderAmount(db, args);
    if (amount != null && amount <= 3000) return 'allow';
  }
  return base;
}

export const PERMISSION_DENIED_MSG = 'запрещено правилами агента';
export const PERMISSION_ASK_MSG =
  'нужно согласование владельца — скажи клиенту, что уточнишь и вернёшься';

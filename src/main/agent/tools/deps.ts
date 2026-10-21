import type { AppEvent, Settings } from '../../../shared/types';
import type { Db } from '../../db';
import type { TelegramEngine } from '../../telegram/types';
import type { OutreachDeps } from '../../pipeline/outreach';
import type { MemoryStore } from '../../memory/types';
import type { Billing } from '../../billing/types';
import type { ExecutorRegistry } from '../../executors/types';
import type { TurnToolState } from './state';
import type { SkillsStore } from '../../skills';

export interface OrderActions {
  applyManagerIntent(leadId: number, intent: import('../../../shared/types').ManagerOrderIntent): Promise<void>;
  requestPayment(orderId: number): Promise<import('../../../shared/types').Order>;
}

export interface HandoffActions {
  doHandoff(leadId: number, reason: string, summary: string, bridgeReply: string): Promise<void>; // bridgeReply often ''
}

export interface ToolHostDeps extends OutreachDeps {
  getSettings: () => Settings;
  memory?: MemoryStore;
  billing?: Billing;
  executors?: ExecutorRegistry;
  orders?: OrderActions;
  handoff?: HandoffActions;
  dataDir?: string;
  skills?: SkillsStore;
  getTasks?: () => import('../tasks').TaskQueue | undefined; // background subagent tasks
  taskDir?: string; // inside a background task: where its files (tables…) go
  turnState: TurnToolState;
}

export type { Db, TelegramEngine, AppEvent };

import type { ManagerOrderIntent } from '../../../shared/types';

export type TurnToolState = {
  replyUsed: boolean;
  replyText: string | null;
  replyVoice: boolean;
  handoff: boolean;
  handoffReason: string;
  handoffSummary: string;
  orderIntent: ManagerOrderIntent | null | undefined;
};

export function freshTurnState(): TurnToolState {
  return {
    replyUsed: false,
    replyText: null,
    replyVoice: false,
    handoff: false,
    handoffReason: '',
    handoffSummary: '',
    orderIntent: undefined,
  };
}

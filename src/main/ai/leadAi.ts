// LeadAi over an OpenAI-compatible chat completions API. Stub: implemented by the AI worker.

import type { Lead, Project, Settings } from '../../shared/types';
import type { TgChat, TgMessage } from '../telegram/types';
import type { DialogTurn, FeedbackExample, LeadAi, ProjectBrief, Qualification } from './types';

const todo = (): never => {
  throw new Error('OpenAiLeadAi: not implemented');
};

export class OpenAiLeadAi implements LeadAi {
  constructor(readonly settings: () => Settings) {}
  async suggestKeywords(_b: ProjectBrief): Promise<string[]> { return todo(); }
  async rateChat(_p: Project, _c: TgChat, _s: TgMessage[]): Promise<{ score: number; reason: string }> { return todo(); }
  async qualify(_p: Project, _m: TgMessage[], _e: FeedbackExample[]): Promise<Qualification[]> { return todo(); }
  async draftReply(_p: Project, _l: Lead, _w: 'dm' | 'chat', _h: DialogTurn[]): Promise<string> { return todo(); }
}

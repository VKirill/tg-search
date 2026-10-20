// Contract of the AI layer. Implemented in ./leadAi.ts over an OpenAI-compatible chat API.

import type { Lead, LeadLabel, Project, ProjectInput } from '../../shared/types';
import type { TgChat, TgMessage } from '../telegram/types';

export type ProjectBrief = Pick<ProjectInput, 'task' | 'target' | 'offer' | 'geo' | 'languages' | 'materials'>;

export interface Qualification {
  key: string; // `${chatId}:${messageId}` of the evaluated message
  score: number; // 0..100 relevance to the project
  label: LeadLabel;
  reason: string; // one short sentence in Russian
}

export interface FeedbackExample {
  text: string;
  verdict: 'up' | 'down';
}

export interface DialogTurn {
  direction: 'in' | 'out';
  text: string;
}

export interface LeadAi {
  // Search phrases people would actually write in Telegram when they need the offer.
  suggestKeywords(brief: ProjectBrief): Promise<string[]>;
  // Quick judgement whether a found chat/channel is worth scanning, from its title, description and sample.
  rateChat(project: Project, chat: TgChat, sample: TgMessage[]): Promise<{ score: number; reason: string }>;
  // Batch qualification. Feedback examples teach the model what the user likes.
  qualify(project: Project, messages: TgMessage[], examples: FeedbackExample[]): Promise<Qualification[]>;
  // Reply for the lead in its language, short and human; history is the dialog so far.
  draftReply(project: Project, lead: Lead, where: 'dm' | 'chat', history: DialogTurn[]): Promise<string>;
}

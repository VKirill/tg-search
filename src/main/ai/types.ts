// Contract of the AI layer. Implemented in ./leadAi.ts over an OpenAI-compatible chat API.

import type { ClientCard, Lead, LeadLabel, ManagerSettings, ManagerTestResult, Project, ProjectInput } from '../../shared/types';
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

// Fast qualification only (Jev via TypeSafe System One). Same contract as LeadAi.qualify.
export interface Qualifier {
  qualify(project: Project, messages: TgMessage[], examples: FeedbackExample[]): Promise<Qualification[]>;
}

// Spins a broadcast text so every post differs slightly while keeping the meaning.
export interface TextSpinner {
  spin(text: string): Promise<string>;
}

// Writes chain messages and runs the AI manager dialog with any OpenAI-compatible model.
export interface ManagerAi {
  // Chain step in 'ai' mode: instruction is the step text; history is what was sent so far.
  writeStep(project: Project, lead: Lead, instruction: string, history: DialogTurn[]): Promise<string>;
  // Next manager message for the dialog, or a handoff decision. settings override project.manager (sandbox).
  // card: current CRM card — the manager asks the open questions of the anamnesis one by one.
  reply(project: Project, lead: Lead, history: DialogTurn[], settings?: ManagerSettings, card?: ClientCard): Promise<ManagerTestResult>;
}

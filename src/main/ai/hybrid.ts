import type { Settings } from '../../shared/types';
import type { LeadAi, Qualifier } from './types';

export function createLeadAi(getSettings: () => Settings, llm: LeadAi, jev: Qualifier): LeadAi {
  return {
    suggestKeywords: (brief) => llm.suggestKeywords(brief),
    rateChat: (project, chat, sample) => llm.rateChat(project, chat, sample),
    draftReply: (project, lead, where, history) => llm.draftReply(project, lead, where, history),
    qualify: (project, messages, examples) => {
      if (getSettings().jevApiKey.trim()) return jev.qualify(project, messages, examples);
      return llm.qualify(project, messages, examples);
    },
  };
}

// Demand map over Jev: for each message one Choice over the enabled categories (plus «none»)
// and one Noul «is this a request for a service or help». Shares the Jev client of ./jev.ts.

import type { Category, Settings } from '../../shared/types';
import type { TgMessage } from '../telegram/types';
import type { Categorizer, Classification } from './types';
import { mapPool, postSystemOne } from './jev';

const CHUNK_SIZE = 10;
const MAX_PARALLEL = 4;
const MAX_TEXT = 1200;
const NONE = 'none';

type ChoiceAnswer = { choice?: string; probabilities?: Record<string, number> };
type NoulAnswer = { noul?: number };

export class JevCategorizer implements Categorizer {
  constructor(private readonly getSettings: () => Settings) {}

  async classify(categories: Category[], messages: TgMessage[]): Promise<Classification[]> {
    if (!this.getSettings().jevApiKey) return []; // without Jev the demand map is simply not built
    const enabled = categories.filter((c) => c.enabled);
    const items = messages.filter((m) => m.text.trim());
    const chunks: TgMessage[][] = [];
    for (let i = 0; i < items.length; i += CHUNK_SIZE) chunks.push(items.slice(i, i + CHUNK_SIZE));
    const parts = await mapPool(chunks, MAX_PARALLEL, (chunk) => this.classifyChunk(enabled, chunk));
    return parts.flat();
  }

  private async classifyChunk(categories: Category[], chunk: TgMessage[]): Promise<Classification[]> {
    const criteria: Record<string, string> = Object.fromEntries(categories.map((c) => [`c${c.id}`, `${c.name}: ${c.description}`]));
    criteria[NONE] = 'None of these: chatter, greetings, news, off-topic, or a topic not listed';
    const questions: Record<string, object> = {};
    chunk.forEach((_, i) => {
      questions[`cat_${i}`] = {
        type: 'choice',
        instructions: `Which category does the topic of \`messages[${i}].text\` belong to?`,
        criteria,
      };
      questions[`req_${i}`] = {
        type: 'noul',
        instructions:
          `Is the author of \`messages[${i}].text\` asking for, ordering or looking to buy a service, a contractor or help ` +
          `(not chatting, not advertising their own services, not posting a job vacancy for staff)?`,
      };
    });
    const state = { messages: chunk.map((m) => ({ text: m.text.trim().slice(0, MAX_TEXT) })) };
    const data = await postSystemOne(this.getSettings, { state, questions });
    const answers = (data.answers ?? {}) as Record<string, ChoiceAnswer & NoulAnswer>;
    return chunk.map((m, i) => {
      const cat = answers[`cat_${i}`];
      const choice = cat?.choice;
      const categoryId = choice && choice !== NONE && choice.startsWith('c') ? Number(choice.slice(1)) : null;
      return {
        key: `${m.chatId}:${m.messageId}`,
        categoryId,
        categoryProb: choice ? cat?.probabilities?.[choice] ?? 0 : 0,
        requestProb: answers[`req_${i}`]?.noul ?? 0,
      };
    });
  }
}

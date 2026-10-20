import type { Settings } from '../../shared/types';
import { chatJsonCompletion } from './llm';
import type { TextSpinner } from './types';

const SPIN_SYSTEM = `You rewrite Telegram posts for periodic reposting.
Keep the same meaning, language, and roughly the same length.
Change wording and sentence order.
Keep contacts, links, @usernames, prices and numbers exactly as in the original.
Do not add new claims or offers.
Reply with JSON only: {"text": "..."}.`;

export class LlmSpinner implements TextSpinner {
  constructor(private readonly settings: () => Settings) {}

  async spin(text: string): Promise<string> {
    const data = await chatJsonCompletion(this.settings, [
      { role: 'system', content: SPIN_SYSTEM },
      { role: 'user', content: text },
    ], { temperature: 0.7 });
    if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
      const out = (data as { text: string }).text.trim();
      if (out) return out;
    }
    throw new Error('Ошибка LLM: неверный формат text');
  }
}

export const passthroughSpinner: TextSpinner = {
  spin: async (text) => text,
};

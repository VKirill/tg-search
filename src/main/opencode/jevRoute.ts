// Jev picks the model for a task: it reads the task and the original (English) descriptions of the candidate models
// and gives each a probability of being the best fit. Cheap and quick, so it runs for every helper job.
import type { Settings } from '../../shared/types';
import { postSystemOne } from '../ai/jev';
import type { Skill } from './profiles';

export interface ModelChoice {
  ref: string;
  text: string; // name, description and facts, in English
}

export async function jevRankModels(
  getSettings: () => Settings,
  task: string,
  needs: Skill[],
  models: ModelChoice[],
  postFn: typeof postSystemOne = postSystemOne,
): Promise<{ ref: string; p: number }[]> {
  const criteria: Record<string, string> = {};
  models.forEach((m, i) => (criteria[`model_${i + 1}`] = m.text));
  const data = await postFn(getSettings, {
    state: { task: task.slice(0, 2000), needs: needs.join(', ') },
    questions: {
      pick: {
        type: 'choice',
        instructions:
          'Which AI model will do `task` best — an accurate, complete result in the language of the task? ' +
          'Judge by what each description says the model is strong at; `needs` lists what the task requires.',
        criteria,
      },
    },
  });
  const probs = (data.answers?.pick as { probabilities?: Record<string, number> } | undefined)?.probabilities ?? {};
  return models
    .map((m, i) => ({ ref: m.ref, p: Number(probs[`model_${i + 1}`] ?? 0) }))
    .sort((a, b) => b.p - a.p);
}

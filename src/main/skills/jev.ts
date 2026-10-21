import type { Settings } from '../../shared/types';
import { postSystemOne } from '../ai/jev';

export interface SkillOption {
  name: string;
  description: string;
}

type ChoiceAnswer = { choice?: string; probabilities?: Record<string, number> };

/** Jev Choice over active skill descriptions (+ none); returns names with prob >= threshold. */
export async function hintSkillsForMessage(
  getSettings: () => Settings,
  clientMessage: string,
  skills: SkillOption[],
  threshold = 0.35,
  postFn: typeof postSystemOne = postSystemOne,
): Promise<string[]> {
  if (!skills.length || !getSettings().jevApiKey.trim()) return [];
  const criteria: Record<string, string> = { none: 'No skill fits this message' };
  for (const s of skills) criteria[s.name] = s.description;
  const data = await postFn(getSettings, {
    state: { message: clientMessage.slice(0, 1200) },
    questions: {
      pick: {
        type: 'choice',
        instructions: 'Which skill (if any) is most likely useful for replying to `message`?',
        criteria,
      },
    },
  });
  const ans = data.answers?.pick as ChoiceAnswer | undefined;
  const probs = ans?.probabilities ?? {};
  const ranked = Object.entries(probs)
    .filter(([k, p]) => k !== 'none' && typeof p === 'number' && p >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);
  if (ranked.length) return ranked;
  if (ans?.choice && ans.choice !== 'none' && (probs[ans.choice] ?? 0) >= threshold) return [ans.choice];
  return [];
}

export async function skillCoversTask(
  getSettings: () => Settings,
  skill: SkillOption,
  taskSummary: string,
  postFn: typeof postSystemOne = postSystemOne,
): Promise<boolean> {
  if (!getSettings().jevApiKey.trim()) return false;
  const data = await postFn(getSettings, {
    state: { skill: skill.description, task: taskSummary.slice(0, 2000) },
    questions: {
      cover: {
        type: 'noul',
        instructions: 'Does the skill described in `skill` fully cover how to handle the work summarized in `task`?',
      },
    },
  });
  const noul = (data.answers?.cover as { noul?: number } | undefined)?.noul ?? 0;
  return noul >= 0.5;
}

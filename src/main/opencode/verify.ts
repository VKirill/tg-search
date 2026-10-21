// A second model checks a helper's result before anyone sees it: free models (and agents whose work must be right —
// solutions) get a verifier from the owner's subscriptions. A low score sends the job to the next model with the notes.
import { parseJsonFromLlm } from '../ai/llm';

export type VerifyMode = 'always' | 'free' | 'off';

export interface Verdict {
  ok: boolean;
  score: number; // 0–1
  note: string; // what is wrong, briefly
}

export const PASS_SCORE = 0.7;

// What every check covers, whatever the job; an agent's `check` adds its own points
const BASE_CHECK = [
  'результат отвечает именно на поручение, ничего не пропущено',
  'нет выдумок: факты, цифры, ссылки, названия компаний и цены не взяты с потолка',
  'нет внутренних противоречий и обрывов на полуслове',
  'язык — как в поручении, без грубых ошибок',
];

export function verifyPrompt(task: string, result: string, checklist: string): string {
  const points = [...BASE_CHECK, ...checklist.split(/;\s*|\n/).map((s) => s.trim()).filter(Boolean)];
  return [
    'Ты — строгий проверяющий. Проверь результат исполнителя по поручению. Если приложены картинки — это исходные материалы поручения.',
    `Что проверить:\n${points.map((p) => `- ${p}`).join('\n')}`,
    'Если есть расчёты — пересчитай ключевые сам, не верь на слово.',
    'Ответ — только JSON: {"score": 0.0–1.0, "ok": true|false, "issues": "что не так и как исправить, коротко; пусто, если всё верно"}.',
    'score ниже 0.7 — если есть ошибка по существу (неверный ответ, выдумка, не то, что просили); мелочи оформления — не повод.',
    '',
    `<task>\n${task.slice(0, 6000)}\n</task>`,
    '',
    `<result>\n${result.slice(0, 20000)}\n</result>`,
  ].join('\n');
}

export function parseVerdict(raw: string): Verdict {
  try {
    const v = parseJsonFromLlm(raw) as { score?: unknown; ok?: unknown; issues?: unknown };
    const score = Math.max(0, Math.min(1, Number(v.score)));
    if (!Number.isFinite(score)) throw new Error('no score');
    return { score, ok: v.ok !== false && score >= PASS_SCORE, note: String(v.issues ?? '').trim() };
  } catch {
    // an unreadable verdict must not throw away a result: pass it, the primary agent still reviews
    return { ok: true, score: PASS_SCORE, note: 'проверяющий ответил не по формату' };
  }
}

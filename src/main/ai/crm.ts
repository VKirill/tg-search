import type { Anamnesis, ChatMessage, ClientCard, DealStage, Lead, Project, Settings } from '../../shared/types';
import { EMPTY_ANAMNESIS } from '../db';
import { chatCompletion, chatJsonCompletion } from './llm';

export interface CrmTimelineLine {
  label: string;
  text: string;
}

export interface CrmAnalyzeResult {
  summary: string;
  anamnesis: Anamnesis;
  completeness: number;
  stage?: DealStage;
}

export interface CrmAi {
  analyze(
    project: Project,
    lead: Lead,
    timeline: CrmTimelineLine[],
    card: ClientCard,
  ): Promise<CrmAnalyzeResult>;
  writeBrief(project: Project, lead: Lead, card: ClientCard, timeline: CrmTimelineLine[]): Promise<string>;
}

export function messageTimelineLabel(m: ChatMessage): string {
  if (m.kind === 'note') return 'Заметка владельца';
  if (m.kind === 'voice') return 'Голосовое клиента (расшифровка)';
  if (m.kind === 'call') return 'Созвон (расшифровка)';
  if (m.direction === 'in') return 'Клиент';
  return m.auto ? 'Мы (авто)' : 'Мы (вручную)';
}

export function buildTimeline(messages: ChatMessage[], lead: Lead): CrmTimelineLine[] {
  const lines: CrmTimelineLine[] = [{ label: 'Клиент', text: lead.text }];
  for (const m of messages) {
    lines.push({ label: messageTimelineLabel(m), text: m.text });
  }
  return lines;
}

export function formatTimelineForPrompt(timeline: CrmTimelineLine[]): string {
  return timeline.map((t) => `${t.label}: ${t.text}`).join('\n');
}

export function mergeAnamnesis(prev: Anamnesis, next: Partial<Anamnesis>): Anamnesis {
  const pickStr = (oldVal: string, newVal: string | undefined) => {
    const n = (newVal ?? '').trim();
    return n ? n : oldVal;
  };
  const pickArr = (oldVal: string[], newVal: string[] | undefined) => {
    const n = (newVal ?? []).map((s) => s.trim()).filter(Boolean);
    if (!n.length) return oldVal;
    const out = [...oldVal];
    for (const item of n) {
      if (!out.includes(item)) out.push(item);
    }
    return out;
  };
  return {
    task: pickStr(prev.task, next.task),
    goal: pickStr(prev.goal, next.goal),
    audience: pickStr(prev.audience, next.audience),
    features: pickArr(prev.features, next.features),
    integrations: pickArr(prev.integrations, next.integrations),
    stack: pickArr(prev.stack, next.stack),
    deadline: pickStr(prev.deadline, next.deadline),
    budget: pickStr(prev.budget, next.budget),
    references: pickArr(prev.references, next.references),
    contacts: pickStr(prev.contacts, next.contacts),
    openQuestions: (next.openQuestions ?? []).length ? next.openQuestions! : prev.openQuestions,
  };
}

export function estimateCompleteness(a: Anamnesis): number {
  const checks = [
    a.task.trim(),
    a.goal.trim(),
    a.audience.trim(),
    a.features.length > 0,
    a.integrations.length > 0 || a.features.some((f) => /интегр|crm|оплат/i.test(f)),
    a.deadline.trim(),
    a.budget.trim(),
    a.contacts.trim() || a.references.length > 0,
  ];
  const filled = checks.filter(Boolean).length;
  return Math.min(100, Math.round((filled / checks.length) * 100));
}

function parseAnamnesis(data: unknown): Partial<Anamnesis> {
  const o = (data ?? {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : undefined);
  return {
    task: typeof o.task === 'string' ? o.task : undefined,
    goal: typeof o.goal === 'string' ? o.goal : undefined,
    audience: typeof o.audience === 'string' ? o.audience : undefined,
    features: arr(o.features),
    integrations: arr(o.integrations),
    stack: arr(o.stack),
    deadline: typeof o.deadline === 'string' ? o.deadline : undefined,
    budget: typeof o.budget === 'string' ? o.budget : undefined,
    references: arr(o.references),
    contacts: typeof o.contacts === 'string' ? o.contacts : undefined,
    openQuestions: arr(o.openQuestions),
  };
}

function parseAnalyzeResult(data: unknown, card: ClientCard): CrmAnalyzeResult {
  const o = (data ?? {}) as Record<string, unknown>;
  const raw = parseAnamnesis(o.anamnesis ?? o);
  const anamnesis = mergeAnamnesis(card.anamnesis, raw);
  const completeness =
    typeof o.completeness === 'number' && Number.isFinite(o.completeness)
      ? Math.max(0, Math.min(100, Math.round(o.completeness)))
      : estimateCompleteness(anamnesis);
  const summary = typeof o.summary === 'string' ? o.summary.trim() : card.summary;
  const stage = typeof o.stage === 'string' ? (o.stage as DealStage) : undefined;
  return { summary, anamnesis, completeness, stage };
}

const ANALYZE_SYSTEM = `Ты аналитик мини-CRM. По переписке обновляешь анамнез клиента и краткое саммари.
Правила:
- Учитывай только факты, которые клиент реально сказал (или расшифровки голоса/созвона). Не выдумывай.
- Объединяй с предыдущим анамнезом: сохраняй известные поля, меняй только если клиент уточнил или исправил.
- openQuestions: важные неизвестные для оценки работы (бюджет, срок, must-have функции, интеграции, готовность контента, кто принимает решение).
- completeness: 0–100, насколько заполнены ключевые поля анамнеза.
- summary: 3–6 строк на русском — кто клиент, что хочет, о чём договорились, где остановились, следующий шаг.
Ответ строго JSON:
{"summary":"...","anamnesis":{"task":"","goal":"","audience":"","features":[],"integrations":[],"stack":[],"deadline":"","budget":"","references":[],"contacts":"","openQuestions":[]},"completeness":0}`;

const BRIEF_SYSTEM = `Ты составляешь короткое техническое задание (Markdown) на русском для владельца, который назовёт цену.
Разделы (заголовки ##):
Клиент и контекст; Задача и цель; Аудитория; Функциональные требования (чеклист); Интеграции;
Предлагаемый стек и архитектура (каждый пункт — одна строка с кратким обоснованием, помечай как предложение);
Контент и материалы; Сроки и бюджет (как сказал клиент); Открытые вопросы; Риски; Объём работ по блокам (S/M/L, без цен).
Коротко и по делу. Только факты из переписки и анамнеза.`;

export class OpenAiCrmAi implements CrmAi {
  constructor(private readonly getSettings: () => Settings) {}

  async analyze(
    project: Project,
    lead: Lead,
    timeline: CrmTimelineLine[],
    card: ClientCard,
  ): Promise<CrmAnalyzeResult> {
    const dialog = formatTimelineForPrompt(timeline);
    const prev = JSON.stringify(card.anamnesis, null, 2);
    const user = `Проект «${project.name}», оффер: ${project.offer}

Лид: ${lead.authorName ?? '—'} (@${lead.authorUsername ?? '—'})
Исходный запрос: ${lead.text}

Предыдущий анамнез:
${prev}

Переписка (по порядку):
${dialog}`;

    const data = await chatJsonCompletion(
      this.getSettings,
      [{ role: 'system', content: ANALYZE_SYSTEM }, { role: 'user', content: user }],
      { temperature: 0.2 },
    );
    return parseAnalyzeResult(data, card);
  }

  async writeBrief(
    project: Project,
    lead: Lead,
    card: ClientCard,
    timeline: CrmTimelineLine[],
  ): Promise<string> {
    const dialog = formatTimelineForPrompt(timeline);
    const user = `Проект «${project.name}»

Клиент: ${lead.authorName ?? '—'}
Анамнез:
${JSON.stringify(card.anamnesis, null, 2)}

Саммари: ${card.summary}

Переписка:
${dialog}`;

    const text = await chatCompletion(
      this.getSettings,
      [{ role: 'system', content: BRIEF_SYSTEM }, { role: 'user', content: user }],
      { temperature: 0.25 },
    );
    const brief = text.trim();
    if (!brief) throw new Error('Ошибка LLM: пустое ТЗ');
    return brief;
  }
}

export function stubCrmAi(): CrmAi {
  const err = async () => {
    throw new Error('CRM-ИИ не настроен');
  };
  return { analyze: err, writeBrief: err };
}

export function emptyAnamnesis(): Anamnesis {
  return { ...EMPTY_ANAMNESIS };
}

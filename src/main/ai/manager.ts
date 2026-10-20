import type { ClientCard, Lead, ManagerSettings, ManagerTestResult, Project, Settings } from '../../shared/types';
import { chatCompletion, chatJsonCompletion, type LlmOverride } from './llm';
import type { DialogTurn, ManagerAi } from './types';

const MANAGER_RULES =
  'Правила: пиши как живой человек на языке собеседника; 1–4 коротких предложения; один вопрос за раз; ' +
  'не выдумывай цены и условия, которых нет в оффере и промпте; ты — помощник {owner}. На вопросы «ты бот?», «ты человек?», ' +
  '«кто ты?» отвечай только, что ты помощник {owner}, собираешь заявку, и возвращайся к задаче; не называй себя живым человеком ' +
  'и не говори «я не бот». ' +
  'Ответ строго JSON: {"reply": "...", "handoff": true|false, "reason": "короткая причина на русском"}. ' +
  'handoff=true, если цель из промпта достигнута (собраны требования, готов к заказу/оплате, договорились о созвоне), ' +
  'полнота анамнеза в карточке ≥ 80%, человек просит человека/договор/смету/цену, злится или тема вне компетенции. При handoff=true reply — короткий мост ' +
  '(например «Передаю коллеге, он свяжется в ближайшее время») или пустая строка.';

function materialsText(project: Project): string {
  const parts = project.materials.map((m) => m.text?.trim()).filter(Boolean) as string[];
  return parts.length ? parts.join('\n\n') : '—';
}

// {owner} in the prompt and rules becomes Settings.ownerName («Кирилл» by default).
function managerContext(project: Project, mgr: ManagerSettings, owner: string): string {
  return `${mgr.prompt}

Контекст проекта «${project.name}»:
Задача: ${project.task}
Кого ищем: ${project.target}
Оффер: ${project.offer}
Критерии: ${project.criteria || '—'}
Материалы:
${materialsText(project)}

${MANAGER_RULES}`.replaceAll('{owner}', owner || 'владельца');
}

function llmFromManager(settings: ManagerSettings): LlmOverride {
  return {
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
  };
}

function effectiveManager(project: Project, override?: ManagerSettings): ManagerSettings {
  return override ? { ...project.manager, ...override } : project.manager;
}

function cardContext(card?: ClientCard): string {
  if (!card) return '';
  const a = card.anamnesis;
  const known = [
    a.task.trim() && `Задача: ${a.task.trim()}`,
    a.goal.trim() && `Цель: ${a.goal.trim()}`,
    a.audience.trim() && `Аудитория: ${a.audience.trim()}`,
    a.features.length && `Функционал: ${a.features.join(', ')}`,
    a.integrations.length && `Интеграции: ${a.integrations.join(', ')}`,
    a.deadline.trim() && `Срок: ${a.deadline.trim()}`,
    a.budget.trim() && `Бюджет: ${a.budget.trim()}`,
    a.contacts.trim() && `Контакты: ${a.contacts.trim()}`,
  ]
    .filter(Boolean)
    .join('\n');
  const questions =
    a.openQuestions.length > 0
      ? `Открытые вопросы (спроси по одному, начиная с самого важного):\n${a.openQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      : 'Открытых вопросов в карточке нет — уточняй задачу, срок и бюджет по ситуации.';
  return `

Карточка клиента (анамнез):
${known || 'Пока мало данных.'}
Полнота анамнеза: ${card.completeness}%
${questions}`;
}

function toChatMessages(history: DialogTurn[]): { role: 'user' | 'assistant'; content: string }[] {
  return history.map((t) => ({
    role: t.direction === 'in' ? 'user' : 'assistant',
    content: t.text,
  }));
}

function parseManagerReply(data: unknown): ManagerTestResult {
  const o = data as { reply?: string; handoff?: boolean; reason?: string };
  return {
    reply: typeof o.reply === 'string' ? o.reply : '',
    handoff: !!o.handoff,
    reason: typeof o.reason === 'string' ? o.reason : '',
  };
}

function parseWriteStep(data: unknown): string {
  const o = data as { text?: string };
  if (typeof o.text !== 'string' || !o.text.trim()) throw new Error('Ошибка LLM: нет текста шага');
  return o.text.trim();
}

export class OpenAiManagerAi implements ManagerAi {
  constructor(private readonly getSettings: () => Settings) {}

  async writeStep(project: Project, lead: Lead, instruction: string, history: DialogTurn[]): Promise<string> {
    const mgr = project.manager;
    const system = `Ты пишешь одно сообщение в цепочке касаний. Следуй инструкции шага, опирайся на запрос лида, на языке лида, 1–3 предложения. Ответ JSON: {"text": "..."}.`;
    const hist = history.map((t) => `${t.direction === 'in' ? 'Лид' : 'Мы'}: ${t.text}`).join('\n');
    const user = `Инструкция шага: ${instruction}

Запрос лида: ${lead.text}
${hist ? `Уже отправлено:\n${hist}` : ''}`;

    const data = await chatJsonCompletion(
      this.getSettings,
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      { temperature: 0.4 },
      llmFromManager(mgr),
    );
    return parseWriteStep(data);
  }

  async reply(
    project: Project,
    lead: Lead,
    history: DialogTurn[],
    settings?: ManagerSettings,
    card?: ClientCard,
  ): Promise<ManagerTestResult> {
    const mgr = effectiveManager(project, settings);
    const system = managerContext(project, mgr, this.getSettings().ownerName) + cardContext(card);
    const messages = [
      { role: 'system' as const, content: system },
      ...toChatMessages(history).map((m) => ({ role: m.role, content: m.content })),
    ];
    const data = await chatJsonCompletion(this.getSettings, messages, { temperature: 0.3 }, llmFromManager(mgr));
    return parseManagerReply(data);
  }

  async handoffSummary(project: Project, lead: Lead, history: DialogTurn[], reason: string): Promise<string> {
    const mgr = project.manager;
    const dialog = history.map((t) => `${t.direction === 'in' ? 'Лид' : 'Мы'}: ${t.text}`).join('\n');
    try {
      const text = await chatCompletion(
        this.getSettings,
        [
          {
            role: 'system',
            content: 'Сожми переписку в 3–5 коротких строк на русском: что хотел клиент, что договорились, что передать менеджеру.',
          },
          {
            role: 'user',
            content: `Причина передачи: ${reason}\n\nПереписка:\n${dialog}`,
          },
        ],
        { temperature: 0.2 },
        llmFromManager(mgr),
      );
      return text.trim();
    } catch {
      const tail = history.slice(-3).map((t) => `${t.direction === 'in' ? 'Лид' : 'Мы'}: ${t.text}`);
      return tail.join('\n');
    }
  }
}

export function stubManagerAi(): ManagerAi {
  const err = () => {
    throw new Error('ИИ-менеджер не настроен');
  };
  return { writeStep: err, reply: err };
}

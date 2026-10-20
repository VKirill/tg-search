import type { Lead, Project, ProjectTask } from '../../shared/types';
import type { TgChat, TgMessage } from '../telegram/types';
import type { DialogTurn, FeedbackExample, ProjectBrief } from './types';

const TASK_LABELS: Record<ProjectTask, string> = {
  clients: 'клиенты — люди, которым нужна услуга или продукт из оффера',
  partners: 'партнёры — коллаборации, совместные проекты, B2B-партнёрство',
  investors: 'инвесторы — фонды и люди, которые ищут сделки и проекты для вложений',
  jobs: 'вакансии — посты с подходящими вакансиями под целевую роль/навыки',
  ads: 'реклама — запросы на размещение рекламы или поиск рекламных площадок',
};

function materialsText(materials: Project['materials']): string {
  const parts = materials.map((m) => m.text?.trim()).filter(Boolean) as string[];
  return parts.length ? parts.join('\n\n') : '—';
}

function languagesLine(languages: string[]): string {
  const langs = languages.length ? languages.join(', ') : 'русский';
  return langs;
}

export function suggestKeywordsSystem(): string {
  return `Ты помогаешь искать лиды в Telegram. Отвечай только валидным JSON.`;
}

export function suggestKeywordsUser(brief: ProjectBrief): string {
  const langs = languagesLine(brief.languages);
  return `Проект: задача «${brief.task}» (${TASK_LABELS[brief.task]}).

Кого/что ищем: ${brief.target}
Оффер (опыт, условия): ${brief.offer}
Гео: ${brief.geo.length ? brief.geo.join(', ') : 'не указано'}
Языки проекта: ${langs}
Материалы:
${materialsText(brief.materials)}

Сгенерируй 12–20 коротких поисковых фраз (2–4 слова), как люди пишут в Telegram, когда им ЭТО НУЖНО — не когда продают.
На каждом языке проекта (по умолчанию русский): запросы («ищу разработчика», «нужен телеграм бот», «кто сделает сайт») и тематические названия для поиска чатов («чат предпринимателей», «фриланс заказы»).
Без хештегов, без дубликатов, строчные буквы.

Ответ JSON: {"keywords": ["фраза1", "фраза2", ...]}`;
}

export function rateChatSystem(): string {
  return `Ты оцениваешь, стоит ли сканировать Telegram-чат на лиды. Отвечай только JSON.`;
}

export function rateChatUser(project: Project, chat: TgChat, sample: TgMessage[]): string {
  const msgs = sample.slice(0, 15).map((m, i) => {
    const t = m.text.slice(0, 300);
    return `${i + 1}. ${t || '(пусто)'}`;
  });
  return `Проект: «${project.name}», задача ${project.task} (${TASK_LABELS[project.task]}).
Цель: ${project.target}
Оффер: ${project.offer}
Гео: ${project.geo.join(', ') || '—'}
Языки: ${languagesLine(project.languages)}

Чат: «${chat.title}» (@${chat.username ?? '—'}), тип ${chat.kind}, участников ${chat.memberCount ?? '?' }.
Описание: ${chat.description?.trim() || '—'}

Примеры сообщений:
${msgs.length ? msgs.join('\n') : '(нет сообщений)'}

Оцени 0–100: насколько вероятно, что в этом чате/канале есть запросы, подходящие под проект (аудитория, активность, доля запросов vs реклама/спам).

Ответ JSON: {"score": число, "reason": "одно короткое предложение на русском"}`;
}

function qualifyTaskHints(task: ProjectTask): string {
  switch (task) {
    case 'partners':
      return 'Партнёры: ищем тех, кто ищет партнёра/коллаб, а не просто рекламирует себя.';
    case 'investors':
      return 'Инвесторы: люди и фонды, которые ищут сделки в нужной нише/гео, а не стартапы, которые только питчат без запроса денег.';
    case 'jobs':
      return 'Вакансии: посты с вакансиями, соответствующими целевой роли из target, а не резюме соискателей.';
    case 'ads':
      return 'Реклама: кто ищет размещение или рекламные каналы, а не просто продаёт услугу SMM.';
    default:
      return 'Клиенты: автору НУЖНО то, что в оффере; понижай score, если автор сам продаёт те же услуги (конкурент).';
  }
}

export function qualifySystem(): string {
  return `Ты квалифицируешь сообщения из Telegram на релевантность проекту. Отвечай только JSON.`;
}

export function qualifyUser(
  project: Project,
  messages: { key: string; text: string }[],
  examples: FeedbackExample[],
): string {
  const exLines = examples.slice(0, 10).map((e) => {
    const mark = e.verdict === 'up' ? '👍 relevant' : '👎 not relevant';
    return `${mark}: ${e.text.slice(0, 500)}`;
  });
  const msgLines = messages.map((m) => `- key="${m.key}"\n${m.text}`);
  return `Проект: «${project.name}», задача ${project.task}.
Цель: ${project.target}
Оффер: ${project.offer}
Гео: ${project.geo.join(', ') || '—'}
Языки: ${languagesLine(project.languages)}
Материалы:
${materialsText(project.materials)}

${qualifyTaskHints(project.task)}

Определения label:
- demand — автор явно нуждается/покупает то, что в оффере (запрос, ТЗ, бюджет, «ищу», «нужен»)
- interest — обсуждает проблему, может стать клиентом
- irrelevant — всё остальное, ВКЛЮЧАЯ конкурентов (предлагают те же услуги), саморекламу, спам, оффтоп. Несовпадение гео/языка снижает score.

Примеры обратной связи пользователя:
${exLines.length ? exLines.join('\n') : '(нет примеров)'}

Сообщения (верни оценку для КАЖДОГО key):
${msgLines.join('\n\n')}

Ответ JSON:
{"items":[{"key":"<chatId>:<messageId>","score":0-100,"label":"demand|interest|irrelevant","reason":"коротко на русском"}]}`;
}

export function draftReplySystem(): string {
  return `Ты пишешь короткий человеческий ответ от первого лица от имени пользователя. Отвечай только JSON.`;
}

export function draftReplyUser(
  project: Project,
  lead: Lead,
  where: 'dm' | 'chat',
  history: DialogTurn[],
): string {
  const hist = history
    .map((t) => `${t.direction === 'in' ? 'Они' : 'Я'}: ${t.text}`)
    .join('\n');
  const len =
    where === 'dm'
      ? '2–4 предложения для лички'
      : '1–2 предложения для чата (короче)';
  return `Проект: ${project.name}
Оффер и опыт:
${project.offer}
${materialsText(project.materials)}

Сообщение лида:
${lead.text}

${hist ? `История переписки:\n${hist}\nПродолжи диалог, не начинай с холодного приветствия.` : 'Холодный контакт: без «Добрый день, уважаемый».'}

Напиши ответ на языке лида (${languagesLine(project.languages)}): упомяни их конкретный запрос, одну уместную строку про опыт из оффера/материалов, вопрос, который двигает диалог. ${len}. Без ссылок, без навязчивых продаж, без спама эмодзи.

Ответ JSON: {"text": "..."}`;
}

import type {
  Account,
  Anamnesis,
  Api,
  AppEvent,
  AutopilotSettings,
  Broadcast,
  ChatInfo,
  ChatItem,
  ChatMessage,
  ChatSummary,
  ClientCard,
  Lead,
  LeadFilter,
  ManagerSettings,
  Project,
  ProjectInput,
  Settings,
  Source,
} from '../../shared/types';
import { DEFAULT_AUTOPILOT, DEFAULT_MANAGER } from '../../shared/types';
import { mockWavDataUrl } from './utils/audio';

const isShot = typeof location !== 'undefined' && location.hash.includes('shot=');
const delay = (ms: number) => (isShot ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));
const now = Date.now();
const day = new Date().toISOString().slice(0, 10);
const MOCK_AUDIO = mockWavDataUrl(2);

let settings: Settings = {
  tgApiId: '12345',
  tgApiHash: '••••••••',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmApiKey: '',
  llmModel: 'anthropic/claude-haiku-5.5',
  jevBaseUrl: 'https://api.openlux.ai/v1',
  jevApiKey: '',
  jevModel: 'jev-1.14.0',
  handoffNotifyTo: '@kirill_work',
  ownerName: 'Кирилл',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttApiKey: '',
  sttModel: 'gpt-4o-transcribe',
  ttsBaseUrl: 'https://api.openai.com/v1',
  ttsApiKey: '',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'nova',
};

const accounts: Account[] = [
  {
    id: 1,
    phone: '+79001234567',
    tgUserId: 1001,
    username: 'kirill_work',
    firstName: 'Кирилл',
    lastName: 'В.',
    photoPath: null,
    status: 'authorized',
    dailyLimit: 10,
    pauseSec: 180,
    sentToday: 5,
    sentDay: day,
    lastSentAt: now - 3600_000,
    isPrimary: true,
  },
  {
    id: 2,
    phone: '+79007654321',
    tgUserId: 1002,
    username: 'tg_outreach',
    firstName: 'Рабочий',
    lastName: 'Аккаунт',
    photoPath: null,
    status: 'authorized',
    dailyLimit: 10,
    pauseSec: 240,
    sentToday: 2,
    sentDay: day,
    lastSentAt: now - 7200_000,
    isPrimary: false,
  },
];

const managerPrompt =
  'Ты — помощник {owner}, собираешь заявку на разработку. Представляйся как помощник {owner}. ' +
  'По одному вопросу за раз: задача, цель, аудитория, функционал, интеграции, сроки, бюджет. ' +
  'Цены не называй. Когда клиент просит цену, созвон или готов оплатить — передай {owner}.' ;

const sequence3 = [
  { delayHours: 0, mode: 'template' as const, text: 'Здравствуйте, {name}! Увидел ваш запрос: «{request}». Могу помочь с разработкой — удобно обсудить в личке?' },
  { delayHours: 24, mode: 'template' as const, text: '{name}, добрый день! Если тема ещё актуальна — напишите, расскажу про опыт с похожими проектами.' },
  { delayHours: 72, mode: 'ai' as const, text: 'Коротко напомни о себе и предложи бесплатную 15-минутную консультацию по задаче клиента.' },
];

function makeAutopilot(partial?: Partial<AutopilotSettings>): AutopilotSettings {
  return { ...DEFAULT_AUTOPILOT, nextRunAt: now + 45 * 60_000, lastRunAt: now - 2 * 3600_000, ...partial };
}

const projects: Project[] = [
  {
    id: 1,
    name: 'Клиенты на разработку',
    task: 'clients',
    target: 'Стартапы и малый бизнес: MVP, автоматизация, Telegram-интеграции',
    offer: 'TypeScript, Electron, React, интеграции с CRM и Telegram',
    criteria:
      'Подходит: явный запрос на разработку ПО, MVP, бота, автоматизацию, доработку сайта/приложения. ' +
      'Не подходит: вакансии без проекта, реклама услуг конкурентов, флуд.',
    geo: ['Россия', 'СНГ'],
    languages: ['русский'],
    accountIds: [1, 2],
    materials: [{ kind: 'url', value: 'https://example.com/portfolio', text: 'Портфолио' }],
    keywords: ['нужен разработчик', 'mvp telegram', 'автоматизация бизнеса'],
    sequence: sequence3,
    manager: {
      ...DEFAULT_MANAGER,
      enabled: true,
      model: 'anthropic/claude-sonnet-5.5',
      prompt: managerPrompt,
      replyDelaySec: 45,
      maxReplies: 12,
      voiceReplies: 'mirror',
    },
    autopilot: makeAutopilot({ enabled: true, scanIntervalMin: 60, aiReply: true, minScore: 85 }),
    createdAt: now - 30 * 86400_000,
  },
  {
    id: 2,
    name: 'Маркетинг · лиды',
    task: 'clients',
    target: 'Владельцы бизнеса, ищущие подрядчика по трафику',
    offer: 'Performance и контент B2B',
    criteria: 'Запрос на маркетолога, таргет, лидогенерацию.',
    geo: ['Москва'],
    languages: ['русский'],
    accountIds: [1],
    materials: [],
    keywords: ['ищу маркетолога'],
    sequence: [],
    manager: { ...DEFAULT_MANAGER, enabled: false },
    autopilot: makeAutopilot(),
    createdAt: now - 20 * 86400_000,
  },
  {
    id: 3,
    name: 'Партнёры · интеграторы',
    task: 'partners',
    target: 'Агентства для white-label',
    offer: 'Разработка под вашим брендом',
    criteria: 'Партнёрство, субподряд, совместные проекты.',
    geo: [],
    languages: ['русский'],
    accountIds: [1],
    materials: [],
    keywords: ['партнёрство разработка'],
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot(),
    createdAt: now - 15 * 86400_000,
  },
];

const sources: Source[] = [
  {
    id: 1,
    projectId: 1,
    tgChatId: 101,
    title: 'Заказы на разработку',
    username: 'dev_orders_ru',
    kind: 'supergroup',
    memberCount: 12400,
    status: 'active',
    foundBy: 'нужен разработчик',
    accountId: 1,
    checkedLeads: 48,
    matchedLeads: 12,
    lastScannedAt: now - 3600_000,
    lastMessageId: 9001,
    createdAt: now - 25 * 86400_000,
  },
  {
    id: 2,
    projectId: 1,
    tgChatId: 102,
    title: 'Стартапы РФ',
    username: 'startup_rf',
    kind: 'channel',
    memberCount: 8900,
    status: 'active',
    foundBy: 'member',
    accountId: 1,
    checkedLeads: 22,
    matchedLeads: 5,
    lastScannedAt: now - 7200_000,
    lastMessageId: 4402,
    createdAt: now - 20 * 86400_000,
  },
  {
    id: 3,
    projectId: 1,
    tgChatId: 103,
    title: 'Импорт CSV · чаты',
    username: 'imported_chat',
    kind: 'group',
    memberCount: 800,
    status: 'candidate',
    foundBy: 'csv',
    accountId: 2,
    checkedLeads: 3,
    matchedLeads: 1,
    lastScannedAt: null,
    lastMessageId: null,
    createdAt: now - 2 * 86400_000,
  },
];

const leads: Lead[] = [
  {
    id: 1,
    projectId: 1,
    sourceId: 1,
    tgChatId: 101,
    tgMessageId: 8801,
    authorUserId: 5001,
    authorName: 'Алексей Морозов',
    authorUsername: 'alexm_dev',
    text: 'Ищу разработчика на MVP мобильного приложения с интеграцией Telegram-бота. Бюджет обсуждаем, сроки 6–8 недель.',
    date: now - 2 * 3600_000,
    link: 'https://t.me/dev_orders_ru/8801',
    score: 96,
    label: 'demand',
    reason: 'Прямой запрос на MVP с Telegram.',
    feedback: 'up',
    status: 'dialog',
    accountId: 1,
    sequenceStep: 1,
    nextStepAt: null,
    handoff: false,
    handoffReason: null,
    createdAt: now - 2 * 3600_000,
  },
  {
    id: 2,
    projectId: 1,
    sourceId: 1,
    tgChatId: 101,
    tgMessageId: 8790,
    authorUserId: 5002,
    authorName: 'Мария К.',
    authorUsername: 'maria_product',
    text: 'Кто может автоматизировать выгрузку лидов из чатов в CRM? HubSpot, нужен пайплайн.',
    date: now - 5 * 3600_000,
    link: 'https://t.me/dev_orders_ru/8790',
    score: 91,
    label: 'demand',
    reason: 'Автоматизация лидов.',
    feedback: null,
    status: 'replied',
    accountId: 1,
    sequenceStep: 2,
    nextStepAt: now + 18 * 3600_000,
    handoff: false,
    handoffReason: null,
    createdAt: now - 5 * 3600_000,
  },
  {
    id: 3,
    projectId: 1,
    sourceId: 2,
    tgChatId: 102,
    tgMessageId: 4390,
    authorUserId: 5003,
    authorName: 'Иван Петров',
    authorUsername: 'ivan_edtech',
    text: 'Нужен техлид part-time на личный кабинет edtech. React + Node.',
    date: now - 86400_000,
    link: 'https://t.me/startup_rf/4390',
    score: 78,
    label: 'interest',
    reason: 'Разработка, но part-time.',
    feedback: null,
    status: 'new',
    accountId: null,
    sequenceStep: 0,
    nextStepAt: now + 2 * 3600_000,
    handoff: false,
    handoffReason: null,
    createdAt: now - 86400_000,
  },
  {
    id: 4,
    projectId: 1,
    sourceId: 1,
    tgChatId: 101,
    tgMessageId: 8770,
    authorUserId: 5004,
    authorName: 'Дмитрий Соколов',
    authorUsername: 'dmitry_saas',
    text: 'Подрядчик на поддержку Electron-приложения, долгосрочно.',
    date: now - 2 * 86400_000,
    link: 'https://t.me/dev_orders_ru/8770',
    score: 88,
    label: 'demand',
    reason: 'Electron — наш стек.',
    feedback: 'up',
    status: 'dialog',
    accountId: 1,
    sequenceStep: 3,
    nextStepAt: null,
    handoff: true,
    handoffReason: 'Клиент просит созвон и оценку',
    createdAt: now - 2 * 86400_000,
  },
  {
    id: 5,
    projectId: 1,
    sourceId: 1,
    tgChatId: 101,
    tgMessageId: 8760,
    authorUserId: 5005,
    authorName: 'Ольга',
    authorUsername: null,
    text: 'Кто делает чат-ботов для записи в салон?',
    date: now - 3 * 86400_000,
    link: 'https://t.me/dev_orders_ru/8760',
    score: 62,
    label: 'interest',
    reason: 'Смежная тема.',
    feedback: 'down',
    status: 'hidden',
    accountId: null,
    sequenceStep: 0,
    nextStepAt: null,
    handoff: false,
    handoffReason: null,
    createdAt: now - 3 * 86400_000,
  },
  {
    id: 6,
    projectId: 2,
    sourceId: null,
    tgChatId: 201,
    tgMessageId: 1,
    authorUserId: 6001,
    authorName: 'Игорь',
    authorUsername: 'igor_biz',
    text: 'Ищу маркетолога на Яндекс и VK для B2B.',
    date: now - 4 * 3600_000,
    link: null,
    score: 84,
    label: 'demand',
    reason: 'Маркетинг.',
    feedback: null,
    status: 'new',
    accountId: null,
    sequenceStep: 0,
    nextStepAt: null,
    handoff: false,
    handoffReason: null,
    createdAt: now - 4 * 3600_000,
  },
];

const briefMd = `## Техническое задание: MVP мобильного приложения

### Цель
Запуск MVP за 6–8 недель с интеграцией Telegram-бота для уведомлений.

### Функционал
- Регистрация и профиль пользователя
- Основной сценарий продукта (3 экрана)
- Push через Telegram-бота

### Интеграции
- Telegram Bot API
- Платёжный провайдер (на выбор)

### Стек (предложение)
- React Native / Expo
- Backend: Node.js + PostgreSQL

### Открытые вопросы
- Детали монетизации
- Дизайн-макеты
`;

const defaultAnamnesis: Anamnesis = {
  task: 'MVP мобильного приложения с Telegram-ботом',
  goal: 'Проверить гипотезу на рынке за 2 месяца',
  audience: 'B2C, 25–40 лет',
  features: ['Регистрация', 'Основной сценарий', 'Уведомления в Telegram'],
  integrations: ['Telegram Bot API', 'Платежи'],
  stack: ['React Native', 'Node.js'],
  deadline: '6–8 недель',
  budget: 'Обсуждается на созвоне',
  references: ['https://example.com/ref-app'],
  contacts: 'dmitry@example.com',
  openQuestions: ['Дизайн в Figma?', 'App Store / Google Play сразу?'],
};

const cards: Record<number, ClientCard> = {
  1: {
    leadId: 1,
    stage: 'discovery',
    summary: 'Обсуждаем MVP: клиент прислал голосовое с уточнением по срокам. ИИ-менеджер собирает анамнез.',
    anamnesis: {
      task: 'MVP мобильного приложения + Telegram-бот',
      goal: 'Быстрый выход на рынок',
      audience: 'Пользователи iOS/Android',
      features: ['Авторизация', 'Лента', 'Бот для статусов'],
      integrations: ['Telegram'],
      stack: ['TypeScript'],
      deadline: '6–8 недель',
      budget: 'Не назван',
      references: [],
      contacts: '',
      openQuestions: ['Бюджет', 'Нужен ли админ-кабинет'],
    },
    brief: '',
    notes: 'Перспективный, ответил быстро.',
    completeness: 55,
    updatedAt: now - 3600_000,
    briefUpdatedAt: null,
  },
  2: {
    leadId: 2,
    stage: 'contacted',
    summary: 'Отправлено 2 сообщения цепочки, клиент молчит — следующий шаг через 18 ч.',
    anamnesis: { ...defaultAnamnesis, task: 'Автоматизация лидов в HubSpot', openQuestions: ['Объём чатов'] },
    brief: '',
    notes: '',
    completeness: 25,
    updatedAt: now - 5 * 3600_000,
    briefUpdatedAt: null,
  },
  3: { leadId: 3, stage: 'new', summary: 'Новый лид, цепочка не запущена.', anamnesis: emptyAnamnesis(), brief: '', notes: '', completeness: 5, updatedAt: now, briefUpdatedAt: null },
  4: {
    leadId: 4,
    stage: 'handed_over',
    summary: 'Анамнез собран, клиент просит созвон. ТЗ сформировано, диалог передан Кириллу.',
    anamnesis: defaultAnamnesis,
    brief: briefMd,
    notes: 'Приоритет: созвон завтра.',
    completeness: 92,
    updatedAt: now - 86400_000,
    briefUpdatedAt: now - 20 * 3600_000,
  },
  5: { leadId: 5, stage: 'lost', summary: 'Скрыт как нерелевантный.', anamnesis: emptyAnamnesis(), brief: '', notes: '', completeness: 0, updatedAt: now, briefUpdatedAt: null },
  6: { leadId: 6, stage: 'new', summary: 'Другая тематика.', anamnesis: emptyAnamnesis(), brief: '', notes: '', completeness: 0, updatedAt: now, briefUpdatedAt: null },
};

const mockChats: ChatSummary[] = [
  { chatId: -1001, title: 'Фриланс · заказы на разработку', username: 'freelance_dev_orders', kind: 'supergroup', memberCount: 18420, isMember: true, unreadCount: 12, lastText: 'Ищу разработчика на Telegram-бота для записи клиентов, бюджет 40–60к', lastDate: now - 4 * 60_000 },
  { chatId: -1002, title: 'Предприниматели · нетворкинг', username: 'biz_networking', kind: 'supergroup', memberCount: 25539, isMember: true, unreadCount: 3, lastText: 'Кто делал интеграцию amoCRM с сайтом? Поделитесь контактом', lastDate: now - 35 * 60_000 },
  { chatId: -1003, title: 'WordPress for developers', username: 'wp4dev', kind: 'supergroup', memberCount: 4210, isMember: true, unreadCount: 0, lastText: 'Обновил плагин, всё взлетело', lastDate: now - 3 * 3600_000 },
  { chatId: 501, title: 'Мария Воронцова', username: 'maria_vorontsova', kind: 'private', memberCount: null, isMember: true, unreadCount: 1, lastText: 'Спасибо! Тогда жду ТЗ завтра', lastDate: now - 6 * 3600_000 },
  { chatId: -1004, title: 'AI и автоматизация бизнеса', username: 'ai_automation_news', kind: 'channel', memberCount: 8857, isMember: true, unreadCount: 7, lastText: 'Разбор: как мы сократили обработку заявок в 3 раза', lastDate: now - 26 * 3600_000 },
];

const mockPublicChats: ChatInfo[] = [
  { chatId: -2001, title: 'Ищу разработчика · биржа заказов', username: 'find_developer_chat', kind: 'supergroup', memberCount: 9312, isMember: false },
  { chatId: -2002, title: 'Telegram-боты: заказы и вакансии', username: 'tg_bots_orders', kind: 'supergroup', memberCount: 5120, isMember: false },
];

function mockChatItems(chatId: number): ChatItem[] {
  const base = now - 3 * 3600_000;
  const lines: [string, string, boolean][] = [
    ['Олег', 'Всем привет! Кто может сделать лендинг под запуск курса за неделю?', false],
    ['Анна', 'Посмотрите портфолио у @studio_landing, делали похожее', false],
    ['Кирилл', 'Олег, могу взяться — напишите в личку детали', true],
    ['Игорь', 'Ищу разработчика на Telegram-бота для записи клиентов, бюджет 40–60к', false],
  ];
  return lines.map(([name, text, out], i) => ({
    messageId: Math.abs(chatId) * 100 + i + 1, date: base + i * 40 * 60_000, text, senderName: name, senderUsername: null,
    isOutgoing: out, voice: i === 1 ? { fileId: 9, durationSec: 7 } : null, replyToMessageId: null, link: null,
  }));
}

function emptyAnamnesis(): Anamnesis {
  return { task: '', goal: '', audience: '', features: [], integrations: [], stack: [], deadline: '', budget: '', references: [], contacts: '', openQuestions: [] };
}

const messages: ChatMessage[] = [
  { id: 1, leadId: 1, accountId: null, direction: 'in', where: 'chat', kind: 'text', text: leads[0].text, mediaPath: null, durationSec: null, tgChatId: 101, tgMessageId: 8801, date: now - 2 * 3600_000, auto: false },
  { id: 2, leadId: 1, accountId: 1, direction: 'out', where: 'dm', kind: 'text', text: 'Алексей, добрый день! Помощник Кирилла — увидел запрос на MVP. Расскажите, какой главный сценарий в приложении?', mediaPath: null, durationSec: null, tgChatId: 5001, tgMessageId: 90001, date: now - 1.8 * 3600_000, auto: true },
  { id: 3, leadId: 1, accountId: null, direction: 'in', where: 'dm', kind: 'text', text: 'Главное — быстрая регистрация и лента заказов. Бот пусть шлёт статусы.', mediaPath: null, durationSec: null, tgChatId: 5001, tgMessageId: 90002, date: now - 1.5 * 3600_000, auto: false },
  { id: 4, leadId: 1, accountId: null, direction: 'in', where: 'dm', kind: 'voice', text: 'Ну и по срокам нам бы уложиться в полтора месяца максимум, если реально.', mediaPath: MOCK_AUDIO, durationSec: 14, tgChatId: 5001, tgMessageId: 90003, date: now - 1.2 * 3600_000, auto: false },
  { id: 5, leadId: 1, accountId: 1, direction: 'out', where: 'dm', kind: 'text', text: 'Понял, полтора месяца — ориентир. А бюджет уже есть в голове или пока только оцениваете?', mediaPath: null, durationSec: null, tgChatId: 5001, tgMessageId: 90004, date: now - 1 * 3600_000, auto: true },
  { id: 10, leadId: 4, accountId: null, direction: 'in', where: 'chat', kind: 'text', text: leads[3].text, mediaPath: null, durationSec: null, tgChatId: 101, tgMessageId: 8770, date: now - 2 * 86400_000, auto: false },
  { id: 11, leadId: 4, accountId: 1, direction: 'out', where: 'dm', kind: 'text', text: 'Дмитрий, здравствуйте! Помощник Кирилла. Поддержка Electron — как раз наш профиль. Что сейчас болит больше всего?', mediaPath: null, durationSec: null, tgChatId: 5004, tgMessageId: 90100, date: now - 1.9 * 86400_000, auto: true },
  { id: 12, leadId: 4, accountId: null, direction: 'in', where: 'dm', kind: 'text', text: 'Давайте созвонимся и обсудим объём. Можете завтра в 15:00?', mediaPath: null, durationSec: null, tgChatId: 5004, tgMessageId: 90101, date: now - 1.5 * 86400_000, auto: false },
  { id: 13, leadId: 4, accountId: null, direction: 'in', where: 'dm', kind: 'call', text: 'Обсудили: два релиза в месяц, приоритет — стабильность сборки и автообновления. Кирилл подключится для оценки.', mediaPath: MOCK_AUDIO, durationSec: 754, tgChatId: 5004, tgMessageId: null, date: now - 20 * 3600_000, auto: false },
  { id: 14, leadId: 4, accountId: null, direction: 'out', where: 'dm', kind: 'note', text: 'Созвон прошёл хорошо, жду ТЗ от ИИ.', mediaPath: null, durationSec: null, tgChatId: 0, tgMessageId: null, date: now - 19 * 3600_000, auto: false },
];

const broadcasts: Broadcast[] = [
  {
    id: 1,
    name: 'Оффер · разработка',
    text: 'Делаю MVP и автоматизацию на TypeScript. Если ищете разработчика — напишите в личку.',
    accountIds: [1, 2],
    chats: [
      { tgChatId: 101, title: 'Заказы на разработку', username: 'dev_orders_ru', lastPostedAt: now - 48 * 3600_000, lastError: null },
      { tgChatId: 102, title: 'Стартапы РФ', username: 'startup_rf', lastPostedAt: now - 50 * 3600_000, lastError: null },
      { tgChatId: 999, title: 'Частный чат', username: null, lastPostedAt: null, lastError: 'Нет прав на отправку' },
    ],
    intervalHours: 72,
    spin: true,
    enabled: true,
    createdAt: now - 10 * 86400_000,
  },
];

const listeners = new Set<(e: AppEvent) => void>();
function emit(e: AppEvent) {
  listeners.forEach((cb) => cb(e));
}

let nextId = 2000;
const nid = () => ++nextId;

function cardFor(leadId: number): ClientCard {
  return { ...(cards[leadId] ?? { leadId, stage: 'new', summary: '', anamnesis: emptyAnamnesis(), brief: '', notes: '', completeness: 0, updatedAt: Date.now(), briefUpdatedAt: null }) };
}

function filterLeads(projectId: number | null, filter?: LeadFilter): Lead[] {
  let list = projectId == null ? [...leads] : leads.filter((l) => l.projectId === projectId);
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    list = list.filter(
      (l) =>
        l.text.toLowerCase().includes(q) ||
        l.authorName?.toLowerCase().includes(q) ||
        l.authorUsername?.toLowerCase().includes(q),
    );
  }
  if (filter?.status && filter.status !== 'all') list = list.filter((l) => l.status === filter.status);
  if (filter?.minScore != null) list = list.filter((l) => l.score >= filter.minScore!);
  return list.sort((a, b) => b.date - a.date);
}

/** Sync seed for browser mock / screenshot mode (hash contains shot=). */
export function getShotBootstrap() {
  const allLeads = projects.flatMap((p) => filterLeads(p.id));
  const uniq = new Map(allLeads.map((l) => [l.id, l]));
  return {
    projects: projects.map((p) => ({ ...p, autopilot: { ...p.autopilot }, manager: { ...p.manager } })),
    accounts: accounts.map((a) => ({ ...a })),
    leads: [...uniq.values()],
  };
}

export function createMockApi(): Api {
  const api: Api = {
    settings: {
      async get() {
        await delay(60);
        return { ...settings };
      },
      async set(patch) {
        await delay(80);
        settings = { ...settings, ...patch };
        return { ...settings };
      },
    },
    accounts: {
      async list() {
        await delay(50);
        return accounts.map((a) => ({ ...a }));
      },
      async startLogin(phone) {
        await delay(300);
        const acc: Account = {
          id: nid(),
          phone,
          tgUserId: null,
          username: null,
          firstName: null,
          lastName: null,
          photoPath: null,
          status: 'wait_code',
          dailyLimit: 10,
          pauseSec: 180,
          sentToday: 0,
          sentDay: day,
          lastSentAt: null,
          isPrimary: accounts.length === 0,
        };
        accounts.push(acc);
        return { accountId: acc.id, status: 'wait_code' };
      },
      async submitCode(accountId, code) {
        await delay(400);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        if (code.length < 4) return { accountId, status: 'wait_code', error: 'Неверный код' };
        acc.status = 'authorized';
        acc.username = 'new_user';
        emit({ type: 'account:update', account: { ...acc } });
        return { accountId, status: 'authorized' };
      },
      async submitPassword(accountId, password) {
        await delay(300);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        if (!password) return { accountId, status: 'wait_password', error: 'Нужен пароль 2FA' };
        acc.status = 'authorized';
        emit({ type: 'account:update', account: { ...acc } });
        return { accountId, status: 'authorized' };
      },
      async update(accountId, patch) {
        await delay(60);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        Object.assign(acc, patch);
        if (patch.isPrimary) accounts.forEach((a) => { if (a.id !== accountId) a.isPrimary = false; });
        emit({ type: 'account:update', account: { ...acc } });
        return { ...acc };
      },
      async remove(accountId) {
        const i = accounts.findIndex((a) => a.id === accountId);
        if (i >= 0) accounts.splice(i, 1);
      },
    },
    projects: {
      async list() {
        await delay(60);
        return projects.map((p) => ({ ...p, autopilot: { ...p.autopilot }, manager: { ...p.manager }, sequence: [...p.sequence] }));
      },
      async create(input) {
        const p: Project = { id: nid(), ...input, autopilot: makeAutopilot(), createdAt: Date.now() };
        projects.push(p);
        emit({ type: 'project:update', project: { ...p } });
        return { ...p };
      },
      async update(id, patch) {
        const p = projects.find((x) => x.id === id);
        if (!p) throw new Error('Проект не найден');
        Object.assign(p, patch);
        emit({ type: 'project:update', project: { ...p, autopilot: { ...p.autopilot } } });
        return { ...p, autopilot: { ...p.autopilot } };
      },
      async remove(id) {
        const i = projects.findIndex((x) => x.id === id);
        if (i >= 0) projects.splice(i, 1);
      },
      async suggestKeywords() {
        await delay(800);
        return ['telegram бот заказ', 'mvp разработка', 'typescript подрядчик'];
      },
    },
    sources: {
      async list(projectId) {
        await delay(40);
        return sources.filter((s) => s.projectId === projectId).map((s) => ({ ...s }));
      },
      async discover(projectId) {
        emit({ type: 'job', projectId, stage: 'Поиск в Telegram…', done: false });
        await delay(1500);
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
        return sources.filter((s) => s.projectId === projectId).map((s) => ({ ...s }));
      },
      async scan(projectId, sourceIds) {
        emit({ type: 'job', projectId, stage: 'Сканирование…', done: false });
        await delay(1200);
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
        return { checked: sourceIds?.length ?? 2, newLeads: 0 };
      },
      async add(projectId, linkOrUsername) {
        const s: Source = {
          id: nid(),
          projectId,
          tgChatId: nid(),
          title: linkOrUsername.replace(/^https?:\/\/(t\.me\/)?/, ''),
          username: linkOrUsername.replace(/^@/, ''),
          kind: 'channel',
          memberCount: null,
          status: 'candidate',
          foundBy: 'manual',
          accountId: 1,
          checkedLeads: 0,
          matchedLeads: 0,
          lastScannedAt: null,
          lastMessageId: null,
          createdAt: Date.now(),
        };
        sources.push(s);
        emit({ type: 'source:update', source: { ...s } });
        return { ...s };
      },
      async importCsv(projectId, csv) {
        emit({ type: 'job', projectId, stage: 'Импорт CSV…', done: false });
        await delay(1200);
        const lines = csv.trim().split(/\n/).filter(Boolean);
        let added = 0;
        const failed: { value: string; error: string }[] = [];
        for (const line of lines.slice(0, 5)) {
          const col = line.split(/[,;]/)[0]?.trim();
          if (!col || col.toLowerCase() === 'link') continue;
          if (col.includes('bad')) {
            failed.push({ value: col, error: 'Чат не найден' });
            continue;
          }
          await api.sources.add(projectId, col);
          added++;
        }
        emit({ type: 'job', projectId, stage: 'Импорт завершён', done: true });
        return { added, skipped: 1, failed };
      },
      async setStatus(sourceId, status) {
        const s = sources.find((x) => x.id === sourceId);
        if (!s) throw new Error('Источник не найден');
        s.status = status;
        emit({ type: 'source:update', source: { ...s } });
        return { ...s };
      },
    },
    leads: {
      async list(projectId, filter) {
        await delay(40);
        return filterLeads(projectId, filter);
      },
      async feedback(leadId, value) {
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        l.feedback = value;
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...l };
      },
      async setStatus(leadId, status) {
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        l.status = status;
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...l };
      },
      async setHandoff(leadId, handoff) {
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        l.handoff = handoff;
        l.handoffReason = handoff ? 'Взято вручную' : null;
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...l };
      },
    },
    messages: {
      async list(leadId) {
        await delay(30);
        return messages.filter((m) => m.leadId === leadId).map((m) => ({ ...m }));
      },
      async draft(leadId) {
        await delay(600);
        const l = leads.find((x) => x.id === leadId);
        return `Здравствуйте${l?.authorName ? `, ${l.authorName.split(' ')[0]}` : ''}! Помощник Кирилла — могу уточнить детали по вашему запросу?`;
      },
      async send(leadId, text, where) {
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        const acc = accounts.find((a) => a.id === (l.accountId ?? 1)) ?? accounts[0];
        if (acc.sentToday >= acc.dailyLimit) throw new Error(`Дневной лимит (${acc.dailyLimit})`);
        acc.sentToday += 1;
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: acc.id,
          direction: 'out',
          where,
          kind: 'text',
          text,
          mediaPath: null,
          durationSec: null,
          tgChatId: l.tgChatId,
          tgMessageId: nid(),
          date: Date.now(),
          auto: false,
        };
        messages.push(msg);
        if (l.status === 'new') l.status = 'replied';
        emit({ type: 'message:new', message: { ...msg } });
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...msg };
      },
    },
    autopilot: {
      async set(projectId, patch) {
        const p = projects.find((x) => x.id === projectId);
        if (!p) throw new Error('Проект не найден');
        p.autopilot = { ...p.autopilot, ...patch };
        emit({ type: 'project:update', project: { ...p, autopilot: { ...p.autopilot } } });
        return { ...p, autopilot: { ...p.autopilot } };
      },
      async runNow(projectId) {
        emit({ type: 'job', projectId, stage: 'Автопилот…', done: false });
        await delay(2000);
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
      },
    },
    crm: {
      async get(leadId) {
        await delay(30);
        return cardFor(leadId);
      },
      async update(leadId, patch) {
        await delay(80);
        const c = { ...cardFor(leadId), ...patch, updatedAt: Date.now() };
        cards[leadId] = c;
        emit({ type: 'crm:update', card: { ...c } });
        return { ...c };
      },
      async refresh(leadId) {
        emit({ type: 'job', projectId: leads.find((l) => l.id === leadId)?.projectId ?? 1, stage: 'Обновляю из переписки…', done: false });
        await delay(1500);
        const c = { ...cardFor(leadId), summary: 'Сводка обновлена по последним сообщениям.', updatedAt: Date.now() };
        cards[leadId] = c;
        emit({ type: 'crm:update', card: { ...c } });
        emit({ type: 'job', projectId: 1, stage: 'Готово', done: true });
        return { ...c };
      },
      async generateBrief(leadId) {
        await delay(1200);
        const c = { ...cardFor(leadId), brief: briefMd, briefUpdatedAt: Date.now(), stage: 'brief_ready' as const, updatedAt: Date.now() };
        cards[leadId] = c;
        emit({ type: 'crm:update', card: { ...c } });
        return { ...c };
      },
      async addNote(leadId, text) {
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: null,
          direction: 'out',
          where: 'dm',
          kind: 'note',
          text,
          mediaPath: null,
          durationSec: null,
          tgChatId: 0,
          tgMessageId: null,
          date: Date.now(),
          auto: false,
        };
        messages.push(msg);
        emit({ type: 'message:new', message: { ...msg } });
        return { ...msg };
      },
      async board(projectId) {
        await delay(50);
        const list = projectId == null ? leads : leads.filter((l) => l.projectId === projectId);
        return list.filter((l) => l.status !== 'hidden').map((lead) => ({ lead: { ...lead }, card: cardFor(lead.id) }));
      },
    },
    voice: {
      async send(leadId, text, where) {
        await delay(500);
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: 1,
          direction: 'out',
          where,
          kind: 'voice',
          text,
          mediaPath: MOCK_AUDIO,
          durationSec: Math.min(30, Math.ceil(text.length / 8)),
          tgChatId: l.tgChatId,
          tgMessageId: nid(),
          date: Date.now(),
          auto: false,
        };
        messages.push(msg);
        emit({ type: 'message:new', message: { ...msg } });
        return { ...msg };
      },
      async preview(text) {
        await delay(400);
        return MOCK_AUDIO;
      },
    },
    calls: {
      async save(leadId, _audio, _mime, durationSec) {
        emit({ type: 'job', projectId: 1, stage: 'Расшифровываю…', done: false });
        await delay(2000);
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: null,
          direction: 'in',
          where: 'dm',
          kind: 'call',
          text: 'Запись созвона: обсудили сроки, бюджет и приоритеты релизов.',
          mediaPath: MOCK_AUDIO,
          durationSec,
          tgChatId: 0,
          tgMessageId: null,
          date: Date.now(),
          auto: false,
        };
        messages.push(msg);
        emit({ type: 'message:new', message: { ...msg } });
        emit({ type: 'job', projectId: 1, stage: 'Готово', done: true });
        return { ...msg };
      },
    },
    manager: {
      async test(projectId, leadText, history, settingsOverride) {
        await delay(500);
        const lower = leadText.toLowerCase();
        const handoff = lower.includes('готов оплатить') || lower.includes('давайте созвонимся') || lower.includes('созвон');
        const p = projects.find((x) => x.id === projectId);
        const mgr = settingsOverride ?? p?.manager;
        const owner = settings.ownerName;
        if (handoff) {
          return { reply: `Спасибо! Передаю заявку ${owner}, он свяжется с вами лично.`, handoff: true, reason: 'Клиент готов к следующему шагу' };
        }
        const lastOut = history.filter((h) => h.direction === 'out').pop();
        if (!lastOut) {
          return { reply: `Здравствуйте! Помощник ${owner}. Расскажите подробнее, что хотите сделать?`, handoff: false, reason: '' };
        }
        return { reply: 'Понял. А какие сроки для вас критичны?', handoff: false, reason: '' };
      },
    },
    broadcasts: {
      async list() {
        await delay(40);
        return broadcasts.map((b) => ({ ...b, chats: [...b.chats] }));
      },
      async create(input) {
        const b: Broadcast = {
          id: nid(),
          name: input.name,
          text: input.text,
          accountIds: input.accountIds,
          chats: input.chatLinks.map((link, i) => ({
            tgChatId: 1000 + i,
            title: link,
            username: link.replace(/^@/, ''),
            lastPostedAt: null,
            lastError: null,
          })),
          intervalHours: input.intervalHours,
          spin: input.spin,
          enabled: false,
          createdAt: Date.now(),
        };
        broadcasts.push(b);
        emit({ type: 'broadcast:update', broadcast: { ...b } });
        return { ...b };
      },
      async update(id, patch) {
        const b = broadcasts.find((x) => x.id === id);
        if (!b) throw new Error('Рассылка не найдена');
        Object.assign(b, patch);
        emit({ type: 'broadcast:update', broadcast: { ...b } });
        return { ...b };
      },
      async remove(id) {
        const i = broadcasts.findIndex((x) => x.id === id);
        if (i >= 0) broadcasts.splice(i, 1);
      },
      async runNow(id) {
        emit({ type: 'job', projectId: 0, stage: 'Рассылка…', done: false });
        await delay(1500);
        emit({ type: 'job', projectId: 0, stage: 'Готово', done: true });
        return { posted: 2, skipped: 1, errors: 0 };
      },
    },
    chats: {
      async list() {
        await delay(120);
        return mockChats.map((c) => ({ ...c }));
      },
      async history(_accountId, chatId, before) {
        await delay(150);
        const all = mockChatItems(chatId);
        return before ? all.filter((m) => m.messageId < before) : all;
      },
      async send(_accountId, chatId, text, replyTo) {
        await delay(200);
        const item: ChatItem = {
          messageId: Date.now(), date: Date.now(), text, senderName: 'Кирилл', senderUsername: 'kirill_vech', isOutgoing: true,
          voice: null, replyToMessageId: replyTo ?? null, link: null,
        };
        const c = mockChats.find((x) => x.chatId === chatId);
        if (c) Object.assign(c, { lastText: text, lastDate: item.date });
        return item;
      },
      async search(_accountId, query) {
        await delay(300);
        const q = query.toLowerCase();
        return [...mockChats, ...mockPublicChats].filter((c) => c.title.toLowerCase().includes(q) || (c.username ?? '').includes(q));
      },
      async join(_accountId, target) {
        await delay(400);
        const c = mockPublicChats.find((x) => x.chatId === target || `@${x.username}` === target) ?? mockPublicChats[0];
        const joined = { ...c, isMember: true };
        mockChats.unshift({ ...joined, unreadCount: 0, lastText: null, lastDate: null });
        return joined;
      },
      async leave(_accountId, chatId) {
        await delay(200);
        const i = mockChats.findIndex((c) => c.chatId === chatId);
        if (i >= 0) mockChats.splice(i, 1);
      },
      async media() {
        return mockWavDataUrl();
      },
    },
    shell: {
      async openExternal(url) {
        window.open(url, '_blank');
      },
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };

  return api;
}

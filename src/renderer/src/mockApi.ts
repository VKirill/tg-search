import type {
  Account,
  Anamnesis,
  Api,
  AppEvent,
  AutopilotSettings,
  Broadcast,
  Category,
  Order,
  Service,
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
  StatsReport,
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
  jevPricePerMTok: '0.042',
  sttPricePerMin: '0.006',
  ttsPricePerMin: '0.015',
  imagePricePerImage: '0.04',
  requestThreshold: '0.2',
  yookassaShopId: '123456',
  yookassaSecretKey: '',
  yookassaReturnUrl: 'https://t.me/kirill_work',
  auxBaseUrl: 'https://9router.example/v1',
  auxApiKey: '',
  auxModel: 'ag/gemini-3.8-flash',
  falKey: '',
  imageModel: 'fal-ai/nano-banana-2/edit', operatorProvider: 'glm', glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '',
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
    clientId: null,
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
    clientId: null,
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
    clientId: null,
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
    clientId: null,
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
    clientId: null,
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
    clientId: null,
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

const mockCategories: Category[] = [
  { id: 1, name: 'IT-разработка', description: 'Сайты, боты, приложения, интеграции, автоматизация', enabled: true },
  { id: 2, name: 'Реклама и маркетинг', description: 'Таргет, контекст, SMM, продвижение', enabled: true },
  { id: 3, name: 'Фото, видео и дизайн', description: 'Нейрофото, монтаж, логотипы, инфографика', enabled: true },
  { id: 4, name: 'Учёба и домашние задания', description: 'Домашние задания, контрольные, решение задач', enabled: true },
  { id: 5, name: 'Карточки маркетплейсов', description: 'Карточки для Wildberries, Ozon: тексты, фото, инфографика', enabled: true },
  { id: 6, name: 'Тексты и копирайтинг', description: 'Статьи, посты, продающие тексты', enabled: true },
];

function mockStats(period: StatsReport['period']): StatsReport {
  const n = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  const days = Array.from({ length: n }, (_, i) => {
    const d = new Date(now - (n - 1 - i) * 86_400_000);
    const analyzed = 2400 + Math.round(900 * Math.sin(i * 1.3) + (i % 3) * 300);
    const requests = Math.round(analyzed * (0.06 + (i % 4) * 0.01));
    const jev = analyzed * 0.000021;
    const llm = 0.04 + (i % 5) * 0.03;
    return {
      day: d.toISOString().slice(0, 10), analyzed, requests, chatter: analyzed - requests, leads: Math.round(requests * 0.18),
      sent: 3 + (i % 4), costUsd: jev + llm + 0.02, costByKind: { jev, llm, stt: 0.012, tts: 0.008, image: 0.08 },
    };
  });
  const totals = days.reduce(
    (t, d) => ({
      analyzed: t.analyzed + d.analyzed, requests: t.requests + d.requests, chatter: t.chatter + d.chatter,
      leads: t.leads + d.leads, sent: t.sent + d.sent, costUsd: t.costUsd + d.costUsd,
      costByKind: { jev: t.costByKind.jev + d.costByKind.jev, llm: t.costByKind.llm + d.costByKind.llm, stt: t.costByKind.stt + d.costByKind.stt, tts: t.costByKind.tts + d.costByKind.tts, image: t.costByKind.image + d.costByKind.image },
    }),
    { analyzed: 0, requests: 0, chatter: 0, leads: 0, sent: 0, costUsd: 0, costByKind: { jev: 0, llm: 0, stt: 0, tts: 0, image: 0 } },
  );
  const share = [0.34, 0.22, 0.14, 0.12, 0.1, 0.08];
  const examples: Record<number, string[]> = {
    1: ['Нужен Telegram-бот для записи клиентов в салон, бюджет до 50к', 'Ищу разработчика: доработать сайт на Tilda и подключить оплату'],
    2: ['Кто настроит таргет ВК для доставки еды? Бюджет на рекламу 100к в месяц', 'Ищу маркетолога на запуск онлайн-курса'],
    3: ['Нужны нейрофото для каталога одежды, 20 образов', 'Смонтировать рилс из моих видео, 10 штук в месяц'],
    4: ['Помогите решить задачи по физике, 9 класс, фото прикрепила', 'Кто сделает контрольную по высшей математике до пятницы?'],
    5: ['Нужна карточка товара для Ozon: инфографика и описание, 5 SKU', 'Ищу дизайнера карточек для WB, обувь'],
    6: ['Нужен копирайтер на тексты для лендинга стоматологии', 'Перевести презентацию на английский, 30 слайдов'],
  };
  const categories = mockCategories.map((c, i) => ({
    categoryId: c.id, name: c.name,
    messages: Math.round(totals.analyzed * share[i] * 0.4), requests: Math.round(totals.requests * share[i]),
    examples: (examples[c.id] ?? []).map((text, k) => ({ text, link: null, date: now - k * 3600_000, prob: 0.95 - k * 0.07 })),
  }));
  categories.push({ categoryId: null, name: 'Без категории', messages: Math.round(totals.analyzed * 0.6), requests: 0, examples: [] } as never);
  return {
    period, days, totals, categories,
    usage: [
      { kind: 'jev', model: 'jev-1.14.0', calls: Math.round(totals.analyzed / 10), inputTokens: totals.analyzed * 450, outputTokens: totals.analyzed * 8, units: totals.analyzed * 2, costUsd: totals.costByKind.jev },
      { kind: 'llm', model: 'anthropic/claude-haiku-5.5', calls: 140 * n, inputTokens: 9_000 * n, outputTokens: 2_000 * n, units: 0, costUsd: totals.costByKind.llm },
      { kind: 'stt', model: 'gpt-4o-transcribe', calls: 6 * n, inputTokens: 0, outputTokens: 0, units: 120 * n, costUsd: totals.costByKind.stt },
      { kind: 'tts', model: 'gpt-4o-mini-tts', calls: 3 * n, inputTokens: 0, outputTokens: 0, units: 32 * n, costUsd: totals.costByKind.tts },
    ],
  };
}

const mockServices: Service[] = [
  { id: 1, kind: 'homework', name: 'Домашнее задание по фото', categoryId: 4, enabled: true, priceMin: 300, priceMax: 1500, instructions: 'Решаем задачи по фото пошагово, с самопроверкой.', model: '', previewEnabled: false, revisions: 1 },
  { id: 2, kind: 'marketplace_card', name: 'Карточка товара для маркетплейса', categoryId: 5, enabled: true, priceMin: 500, priceMax: 3000, instructions: 'SEO-название, описание, характеристики, инфографика 1–5 слайдов.', model: '', previewEnabled: true, revisions: 2 },
  { id: 3, kind: 'image_gen', name: 'Нейрофото и генерация изображений', categoryId: 3, enabled: true, priceMin: 500, priceMax: 2500, instructions: 'Нейрофотосессии и обложки; фото клиента только с согласия.', model: '', previewEnabled: true, revisions: 1 },
  { id: 4, kind: 'copywriting', name: 'Тексты и контент-план', categoryId: 6, enabled: true, priceMin: 300, priceMax: 3000, instructions: 'Посты и контент-план без брифа: допущения называем явно.', model: '', previewEnabled: true, revisions: 2 },
];

const MOCK_IMG = {
  input: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mP8z8BQzwAE/AUIhC6e3QAAAABJRU5ErkJggg==',
  output: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAF0lEQVR42mNkYGD4z0AEYBxVSF+FABJSAQ8bAW0AAAAASUVORK5CYII=',
};

const mockOrders: Order[] = [
  {
    id: 101, leadId: 1, serviceId: 2, status: 'collecting', price: null,
    brief: 'Карточка кроссовок, референс — Nike Air, 5 слайдов инфографики.',
    files: [{ path: MOCK_IMG.input, role: 'input', name: 'ref.jpg', mime: 'image/png' }],
    paymentId: null, paymentUrl: null, paidAt: null, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 5 * 3600_000, updatedAt: now - 3600_000,
  },
  {
    id: 102, leadId: 1, serviceId: 1, status: 'quoted', price: 800,
    brief: 'Физика 9 класс, 4 задачи по фото.',
    files: [], paymentId: null, paymentUrl: null, paidAt: null, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 2 * 86400_000, updatedAt: now - 86400_000,
  },
  {
    id: 103, leadId: 1, serviceId: 3, status: 'awaiting_payment', price: 1500,
    brief: 'Нейрофото для аватара канала, стиль «деловой портрет».',
    files: [{ path: MOCK_IMG.preview, role: 'preview', name: 'preview.png', mime: 'image/png' }],
    paymentId: 'pay-demo-1', paymentUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=demo-wb-103',
    paidAt: null, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 3 * 86400_000, updatedAt: now - 12 * 3600_000,
  },
  {
    id: 104, leadId: 1, serviceId: 4, status: 'paid', price: 600,
    brief: 'Контент-план на неделю для Telegram-канала про разработку.',
    files: [], paymentId: 'pay-demo-2', paymentUrl: null, paidAt: now - 6 * 3600_000, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 4 * 86400_000, updatedAt: now - 5 * 3600_000,
  },
  {
    id: 105, leadId: 1, serviceId: 2, status: 'in_progress', price: 2200,
    brief: 'Карточка термоса для Ozon, 3 SKU.',
    files: [{ path: MOCK_IMG.input, role: 'input', name: 'product.jpg', mime: 'image/png' }],
    paymentId: null, paymentUrl: null, paidAt: now - 2 * 86400_000, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 5 * 86400_000, updatedAt: now - 2 * 3600_000,
  },
  {
    id: 106, leadId: 2, serviceId: 2, status: 'delivered', price: 1800,
    brief: 'WB: чехол для iPhone, SEO и инфографика.',
    files: [
      { path: MOCK_IMG.output, role: 'output', name: 'card-final.png', mime: 'image/png' },
      { path: MOCK_IMG.preview, role: 'preview', name: 'preview.png', mime: 'image/png' },
    ],
    paymentId: null, paymentUrl: null, paidAt: now - 3 * 86400_000,
    result: 'Готово: 5 слайдов инфографики + описание и характеристики в файле.',
    revisionsUsed: 0, error: null,
    createdAt: now - 7 * 86400_000, updatedAt: now - 86400_000,
  },
  {
    id: 107, leadId: 2, serviceId: 3, status: 'revision', price: 900,
    brief: 'Нейрофото, клиент просит другой фон.',
    files: [{ path: MOCK_IMG.output, role: 'output', name: 'v1.png', mime: 'image/png' }],
    paymentId: null, paymentUrl: null, paidAt: now - 5 * 86400_000, result: 'Первая версия портрета.', revisionsUsed: 1, error: null,
    createdAt: now - 6 * 86400_000, updatedAt: now - 4 * 3600_000,
  },
  {
    id: 108, leadId: 2, serviceId: 1, status: 'done', price: 500,
    brief: 'Математика, контрольная.',
    files: [], paymentId: null, paymentUrl: null, paidAt: now - 10 * 86400_000,
    result: 'Решение с пояснениями отправлено в PDF.', revisionsUsed: 0, error: null,
    createdAt: now - 12 * 86400_000, updatedAt: now - 9 * 86400_000,
  },
  {
    id: 109, leadId: 2, serviceId: 4, status: 'cancelled', price: null,
    brief: 'Клиент передумал.',
    files: [], paymentId: null, paymentUrl: null, paidAt: null, result: null, revisionsUsed: 0, error: null,
    createdAt: now - 8 * 86400_000, updatedAt: now - 7 * 86400_000,
  },
  {
    id: 110, leadId: 2, serviceId: 2, status: 'failed', price: 1200,
    brief: 'Сложный макет, fal.ai недоступен.',
    files: [], paymentId: null, paymentUrl: null, paidAt: now - 86400_000, result: null, revisionsUsed: 0,
    error: 'Генерация изображения не удалась после 3 попыток. Передано владельцу.',
    createdAt: now - 2 * 86400_000, updatedAt: now - 20 * 3600_000,
  },
];

function mockOrderPatch(id: number, patch: Partial<Order>): Order {
  const o = mockOrders.find((x) => x.id === id)!;
  Object.assign(o, patch, { updatedAt: Date.now() });
  const copy = { ...o, files: [...o.files] };
  emit({ type: 'order:update', order: copy });
  return copy;
}

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
        const owner = settings.ownerName;
        if (lower.includes('карточк') && (lower.includes('wb') || lower.includes('wildberries') || lower.includes('вб'))) {
          return {
            reply:
              'Сделаем карточку для Wildberries: уточню категорию, конкурентов и сколько слайдов инфографики нужно. Могу набросать превью обложки — это бесплатно.',
            handoff: false,
            reason: '',
            order: {
              serviceId: 2,
              brief: 'Карточка товара для WB: клиент прислал ссылку на конкурента, нужны SEO-название, описание и 3–5 слайдов инфографики.',
              agreedPrice: 1200,
              wantsPreview: true,
              readyToPay: false,
              photoConsent: false,
            },
          };
        }
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
    clients: {
      async list() {
        return [];
      },
      async get(id) {
        return { id, tgUserId: null, name: 'Клиент', username: null, leadIds: [], createdAt: now, lastSeenAt: null };
      },
      async byLead() {
        return null;
      },
    },
    memory: {
      async facts() {
        return [];
      },
      async addFact(clientId, kind, text) {
        return { id: nid(), clientId, kind, text, source: 'owner', active: true, createdAt: Date.now() };
      },
      async removeFact() {},
      async episodes() {
        return [];
      },
      async assets() {
        return [];
      },
      async sendAsset() {},
    },
    billing: {
      async plans() {
        return [];
      },
      async savePlan(plan) {
        return { ...plan, id: plan.id ?? nid() };
      },
      async removePlan() {},
      async subscriptions() {
        return [];
      },
      async subscribe() {
        throw new Error('Подписки в демо-режиме не оформляются');
      },
      async cancelSubscription() {
        throw new Error('Подписки в демо-режиме не изменяются');
      },
      async payments() {
        return [];
      },
      async checkPayment() {
        throw new Error('Платежи в демо-режиме не проверяются');
      },
    },
    agent: {
      async trace() {
        return [];
      },
    },
    services: {
      async list() {
        return mockServices.map((x) => ({ ...x }));
      },
      async create(input) {
        const v = { id: nid(), ...input };
        mockServices.push(v);
        return { ...v };
      },
      async update(id, patch) {
        const v = mockServices.find((x) => x.id === id)!;
        Object.assign(v, patch);
        return { ...v };
      },
      async remove(id) {
        const i = mockServices.findIndex((x) => x.id === id);
        if (i >= 0) mockServices.splice(i, 1);
      },
    },
    orders: {
      async list(leadId) {
        return mockOrders.filter((o) => leadId == null || o.leadId === leadId).map((o) => ({ ...o }));
      },
      async create(leadId, serviceId, brief) {
        const o: Order = {
          id: nid(), leadId, serviceId, status: 'collecting', price: null, brief, files: [], paymentId: null, paymentUrl: null,
          paidAt: null, result: null, revisionsUsed: 0, error: null, createdAt: Date.now(), updatedAt: Date.now(),
        };
        mockOrders.unshift(o);
        const copy = { ...o, files: [] };
        emit({ type: 'order:update', order: copy });
        return copy;
      },
      async update(id, patch) {
        return mockOrderPatch(id, patch);
      },
      async requestPayment(id) {
        await delay(400);
        return mockOrderPatch(id, { status: 'awaiting_payment', paymentUrl: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=demo' });
      },
      async markPaid(id) {
        return mockOrderPatch(id, { status: 'paid', paidAt: Date.now() });
      },
      async run(id) {
        await delay(800);
        return mockOrderPatch(id, { status: 'delivered', result: 'Готово: решение отправлено клиенту.' });
      },
      async deliver(id) {
        return mockOrderPatch(id, { status: 'delivered' });
      },
      async cancel(id) {
        return mockOrderPatch(id, { status: 'cancelled' });
      },
    },
    dossier: {
      async path(leadId) {
        return `~/Library/Application Support/TG Search/clients/${leadId}`;
      },
      async open() {},
    },
    stats: {
      async report(period) {
        await delay(150);
        return mockStats(period);
      },
    },
    categories: {
      async list() {
        return mockCategories.map((c) => ({ ...c }));
      },
      async create(input) {
        const c = { id: nid(), enabled: true, ...input };
        mockCategories.push(c);
        return { ...c };
      },
      async update(id, patch) {
        const c = mockCategories.find((x) => x.id === id)!;
        Object.assign(c, patch);
        return { ...c };
      },
      async remove(id) {
        const i = mockCategories.findIndex((x) => x.id === id);
        if (i >= 0) mockCategories.splice(i, 1);
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

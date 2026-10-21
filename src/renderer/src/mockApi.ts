import { DEFAULT_CHANNEL_AUDIENCES, DEFAULT_CHANNEL_CATEGORIES } from '../../shared/types';
import type {
  ChannelDesk,
  ChannelItem,
  ChannelPost,
  ChannelSource,
  HelperChat,
  HelperRequest,
  HelperScenarioDef,
  KnowledgeBase,
  KnowledgeDoc,
  Account,
  AgentStep,
  Anamnesis,
  Api,
  AppEvent,
  Asset,
  AutopilotSettings,
  Broadcast,
  AgentDef,
  Approval,
  Category,
  Client,
  MemoryEpisode,
  MemoryFact,
  Order,
  Payment,
  Plan,
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
  SkillDef,
  AiModel,
  AiModelsView,
  AiProvider,
  NewsChannel,
  NewsItem,
  SpamChat,
  TrustedContact,
  SpamTemplate,
  StatsReport,
  Source,
  Subscription,
} from '../../shared/types';
import { BUILTIN_HELPER_SCENARIOS, DEFAULT_AUTOPILOT, DEFAULT_MANAGER } from '../../shared/types';
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
  imageModel: 'fal-ai/nano-banana-2/edit',
  newsInterests: 'ИИ в маркетинге и рекламе, новые нейросети и ИИ-инструменты, обновления Telegram, Яндекс Директа и маркетплейсов',
  operatorProvider: 'glm',
  glmApiKey: '',
  deepseekApiKey: '',
  operatorBaseUrl: '',
  operatorApiKey: '',
  operatorModel: '',
  tavilyApiKey: '',
  geminiApiKey: '',
  aiProviders: '[]',
  aiMainModel: 'zai-coding-plan/glm-5.3-flash',
  aiHelperModels: '["router9/ag/gemini-3.8-flash"]',
  aiUseFree: '1',
  aiVerifierModel: '', helperChats: '[]', helperDailyPerUser: '5', helperPauseSec: '5', helperScenarios: '[]',
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
    agent: '',
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
    agent: '',
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
    agent: '',
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
    clientId: 1,
    repeatCount: 0,
    spamTemplateId: null,
    categoryId: 1,
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
    repeatCount: 3,
    spamTemplateId: null,
    categoryId: 2,
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
    repeatCount: 0,
    spamTemplateId: null,
    categoryId: 7,
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
    clientId: 2,
    repeatCount: 0,
    spamTemplateId: null,
    categoryId: 4,
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
    repeatCount: 0,
    spamTemplateId: null,
    categoryId: 8,
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
    repeatCount: 0,
    spamTemplateId: null,
    categoryId: null,
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

const mockAiProviders: AiProvider[] = [
  { id: 'router9', name: '9router', kind: 'openai-compatible', baseURL: 'https://9router.example/v1', hasKey: true, models: 3 },
  { id: 'openlux-claude', name: 'openlux Claude', kind: 'openai-compatible', baseURL: 'https://openlux.example/v1', hasKey: true, models: 3 },
  { id: 'deepseek', name: 'DeepSeek', kind: 'catalog', baseURL: null, hasKey: true, models: 0 },
  { id: 'zai-coding-plan', name: 'Z.ai (GLM)', kind: 'catalog', baseURL: null, hasKey: true, models: 0 },
];
const mockKnowledgeBases: KnowledgeBase[] = [{ id: 1, name: 'Справка Яндекс Директа', description: 'Документация и методички по Директу', docs: 2, chunks: 340, createdAt: Date.now() - 86400_000 }];
const mockKnowledgeDocs: KnowledgeDoc[] = [
  { id: 1, baseId: 1, title: 'Справка Яндекс Директа — ставки и стратегии', source: 'https://yandex.ru/support/direct/', chars: 182000, chunks: 160, embedded: 160, status: 'ready', error: null, createdAt: Date.now() - 86400_000 },
  { id: 2, baseId: 1, title: 'Методичка по семантике', source: '/Users/me/Документы/semantika.md', chars: 210000, chunks: 180, embedded: 120, status: 'indexing', error: null, createdAt: Date.now() - 3600_000 },
];
const mockScenarios: HelperScenarioDef[] = BUILTIN_HELPER_SCENARIOS.map((x) => ({ ...x }));
const mockDesks: ChannelDesk[] = [{
  id: 1, chatId: -1009000000001, title: 'Sevilla al día', username: 'city_demo', accountId: 1, enabled: true, language: 'español',
  about: 'Noticias, ofertas y eventos de Sevilla para residentes', editorPrompt: '', autopublish: false, threshold: 0.6,
  area: 'Sevilla y su área metropolitana', links: 'none', categories: DEFAULT_CHANNEL_CATEGORIES, audiences: DEFAULT_CHANNEL_AUDIENCES, alerts: false, cover: true, coverStyle: '',
  slots: [{ time: '09:00', kind: 'digest' }, { time: '19:00', kind: 'deals' }], createdAt: Date.now() - 86400_000,
}];
const mockChannelSources: ChannelSource[] = [
  { id: 1, deskId: 1, kind: 'rss', title: 'Diario local', target: 'https://news.example/rss', enabled: true, intervalMin: 30, lastRunAt: Date.now() - 600_000, lastError: null, found: 42, createdAt: Date.now() - 86400_000 },
  { id: 2, deskId: 1, kind: 'search', title: 'Ofertas hoy', target: 'oferta hoy Sevilla restaurante', enabled: true, intervalMin: 180, lastRunAt: Date.now() - 3600_000, lastError: null, found: 9, createdAt: Date.now() - 86400_000 },
];
const mockChannelItems: ChannelItem[] = [
  { id: 1, deskId: 1, sourceId: 1, sourceTitle: 'Diario local', kind: 'news', title: 'El autobús amplía horarios nocturnos', text: 'Desde el lunes, nuevas líneas nocturnas…', url: 'https://example.com/emt', image: null, publishedAt: Date.now() - 3600_000, score: 0.86, local: 0.9, category: 'city.transport', storyId: 1, audiences: [], status: 'new', createdAt: Date.now() - 3000_000 },
  { id: 2, deskId: 1, sourceId: 2, sourceTitle: 'Ofertas hoy', kind: 'deal', title: '2x1 en horchata en Triana', text: 'Solo este fin de semana…', url: 'https://example.com/horchata', image: null, publishedAt: Date.now() - 7200_000, score: 0.74, local: 0.95, category: 'deals.food', storyId: 2, audiences: ['evening', 'free'], status: 'new', createdAt: Date.now() - 7000_000 },
];
const mockChannelPosts: ChannelPost[] = [];
const mockHelperChats: HelperChat[] = [{ chatId: -1001234567890, title: 'Помощь с уроками', username: 'study_help_chat', accountId: 1, enabled: true, scenario: 'tasks', about: 'помощь с домашкой для школьников' }];
const mockAiChoice = { main: 'zai-coding-plan/glm-5.3-flash', helpers: ['router9/ag/gemini-3.8-flash-medium', 'openlux-claude/claude-sonnet-5-5'], useFree: true };
function mockAiModels(): AiModelsView {
  const m = (ref: string, name: string, vision: boolean, costIn: number, costOut: number, variants: string[] = []): AiModel => ({
    ref, providerID: ref.split('/')[0], name, vision, tools: true, variants, costIn, costOut, context: 200_000,
    free: ref.endsWith(':free'), summary: null, strengths: [],
  });
  return {
    models: [
      m('zai-coding-plan/glm-5.3-flash', 'GLM 5.3 Flash', false, 0, 0, ['low', 'medium', 'high']),
      m('router9/ag/gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)', true, 0.3, 2.5),
      m('openlux-claude/claude-sonnet-5-5', 'Claude Sonnet 5.5', true, 3, 15, ['low', 'medium', 'high']),
      m('openlux-claude/claude-opus-5-5', 'Claude Opus 5.5', true, 15, 75, ['low', 'medium', 'high', 'max']),
      m('deepseek/deepseek-flash', 'DeepSeek Flash', false, 0.1, 0.4),
      m('openrouter/google/gemma-4-31b-it:free', 'Google: Gemma 4 31B (free)', true, 0, 0, ['none', 'thinking']),
    ],
    main: mockAiChoice.main,
    helpers: mockAiChoice.helpers,
    useFree: mockAiChoice.useFree,
  };
}

const mockTrusted: TrustedContact[] = [
  { username: 'tester_friend', userId: 501, free: true, dailyCheckin: true, checkinHour: 11, lastCheckinAt: Date.now() - 3600_000, note: '' },
];

const mockNewsChannels: NewsChannel[] = [
  { id: 1, tgChatId: -1009101, title: 'ИИ для маркетолога', username: 'ai_marketing_news', enabled: true, lastMessageId: 812, lastCheckedAt: Date.now() - 600_000, createdAt: Date.now() - 86400_000 },
  { id: 2, tgChatId: -1009102, title: 'Директ без воды', username: 'direct_news', enabled: true, lastMessageId: 233, lastCheckedAt: Date.now() - 600_000, createdAt: Date.now() - 86400_000 },
];
const mockNewsItems: NewsItem[] = [
  { id: 1, channelId: 1, channelTitle: 'ИИ для маркетолога', tgChatId: -1009101, tgMessageId: 812, text: 'Вышла новая модель генерации видео: ролики до 60 секунд по тексту, есть API, цена — от 0,05 $ за секунду. Первые тесты на рекламных креативах показывают CTR выше на 18%.', link: 'https://t.me/ai_marketing_news/812', date: Date.now() - 3600_000, score: 91, summary: 'Новая модель делает рекламные видео до минуты по тексту; в тестах CTR креативов вырос на 18%.', why: 'Готовая тема для обзора: инструмент для креативов с цифрами.', status: 'new', createdAt: Date.now() - 3000_000 },
  { id: 2, channelId: 2, channelTitle: 'Директ без воды', tgChatId: -1009102, tgMessageId: 233, text: 'Яндекс Директ запустил автотаргетинг по образу клиента: можно загрузить сегмент покупателей, и система найдёт похожие запросы. Пока в бете для части аккаунтов.', link: 'https://t.me/direct_news/233', date: Date.now() - 7200_000, score: 78, summary: 'В Директе бета автотаргетинга по сегменту покупателей.', why: 'Новость для клиентов на Директ — повод для поста.', status: 'new', createdAt: Date.now() - 7000_000 },
];

const mockSpamChats: SpamChat[] = [
  { tgChatId: -1009001, title: 'WB партнёры | чат', username: 'wb_partners_chats', reason: '41 из 43 сообщений за неделю — спам и повторы', messages: 43, liveShare: 0.05, source: 'auto', createdAt: Date.now() - 3600_000 },
];

const mockCategories: Category[] = [
  { id: 1, name: 'Сайты и лендинги', description: 'Сайты, лендинги, интернет-магазины, вёрстка', enabled: true },
  { id: 2, name: 'Яндекс Директ и контекст', description: 'Настройка и ведение Директа, контекстная реклама', enabled: true },
  { id: 3, name: 'Фото и видео', description: 'Нейрофото, обработка фото, монтаж', enabled: true },
  { id: 4, name: 'Telegram-боты и автоматизация', description: 'Боты, мини-приложения, интеграции, автоматизация', enabled: true },
  { id: 5, name: 'Таргет и SMM', description: 'Таргет, соцсети, посевы', enabled: true },
  { id: 6, name: 'SEO-продвижение', description: 'SEO, аудит, семантика', enabled: true },
  { id: 7, name: 'Дизайн', description: 'Логотипы, баннеры, обложки, презентации', enabled: true },
  { id: 8, name: 'Карточки маркетплейсов', description: 'Карточки для Wildberries, Ozon: тексты, фото, инфографика', enabled: true },
  { id: 9, name: 'Тексты и копирайтинг', description: 'Статьи, посты, продающие тексты', enabled: true },
  { id: 10, name: 'Учёба и домашние задания', description: 'Домашние задания, контрольные, решение задач', enabled: true },
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
  { id: 1, kind: 'homework', name: 'Домашнее задание по фото', categoryId: 4, enabled: true, priceMin: 300, priceMax: 1500, instructions: 'Решаем задачи по фото пошагово, с самопроверкой.', model: '', previewEnabled: false, revisions: 1, agent: '' },
  { id: 2, kind: 'marketplace_card', name: 'Карточка товара для маркетплейса', categoryId: 5, enabled: true, priceMin: 500, priceMax: 3000, instructions: 'SEO-название, описание, характеристики, инфографика 1–5 слайдов.', model: '', previewEnabled: true, revisions: 2, agent: '' },
  { id: 3, kind: 'image_gen', name: 'Нейрофото и генерация изображений', categoryId: 3, enabled: true, priceMin: 500, priceMax: 2500, instructions: 'Нейрофотосессии и обложки; фото клиента только с согласия.', model: '', previewEnabled: true, revisions: 1, agent: '' },
  { id: 4, kind: 'copywriting', name: 'Тексты и контент-план', categoryId: 6, enabled: true, priceMin: 300, priceMax: 3000, instructions: 'Посты и контент-план без брифа: допущения называем явно.', model: '', previewEnabled: true, revisions: 2, agent: '' },
];

const MOCK_IMG = {
  input: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR42mP8z8BQzwAE/AUIhC6e3QAAAABJRU5ErkJggg==',
  output: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAF0lEQVR42mNkYGD4z0AEYBxVSF+FABJSAQ8bAW0AAAAASUVORK5CYII=',
};

const mockClients: Client[] = [
  {
    id: 1,
    tgUserId: 5001,
    name: 'Алексей Морозов',
    username: 'alexm_dev',
    leadIds: [1],
    createdAt: now - 45 * 86400_000,
    lastSeenAt: now - 3600_000,
  },
  {
    id: 2,
    tgUserId: 5004,
    name: 'Дмитрий Соколов',
    username: 'dmitry_saas',
    leadIds: [4],
    createdAt: now - 30 * 86400_000,
    lastSeenAt: now - 86400_000,
  },
];

const mockFacts: MemoryFact[] = [
  { id: 1, clientId: 1, kind: 'profile', text: 'Стартап в edtech, команда 4 человека, нужен MVP за 6–8 недель.', source: 'сообщение 90002', active: true, createdAt: now - 20 * 3600_000 },
  { id: 2, clientId: 1, kind: 'profile', text: 'Telegram: @alexm_dev, предпочитает переписку, созвоны — только после ТЗ.', source: 'агент', active: true, createdAt: now - 18 * 3600_000 },
  { id: 3, clientId: 1, kind: 'preference', text: 'Стек: TypeScript, React Native; бэкенд без жёстких предпочтений.', source: 'голосовое 90003', active: true, createdAt: now - 15 * 3600_000 },
  { id: 4, clientId: 1, kind: 'deal', text: 'Ориентир по срокам — полтора месяца, бюджет обсуждается после анамнеза.', source: 'агент', active: true, createdAt: now - 12 * 3600_000 },
  { id: 5, clientId: 1, kind: 'material', text: 'Референс по UX — лента заказов как в Яндекс Еде.', source: 'сообщение 90002', active: true, createdAt: now - 14 * 3600_000 },
  { id: 6, clientId: 1, kind: 'other', text: 'Спрашивал, бот ли помощник — ответили по скрипту владельца.', source: 'агент', active: true, createdAt: now - 10 * 3600_000 },
];

const mockEpisodes: MemoryEpisode[] = [
  {
    id: 1,
    clientId: 1,
    fromMs: now - 5 * 86400_000,
    toMs: now - 2 * 86400_000,
    summary: 'Первый контакт: запрос на MVP, уточнили главный сценарий (лента заказов + бот для статусов). Клиент ответил быстро.',
    messages: 28,
  },
  {
    id: 2,
    clientId: 1,
    fromMs: now - 2 * 86400_000,
    toMs: now - 3600_000,
    summary: 'Уточнение сроков голосовым, вопрос про бюджет. Параллельно открыт заказ на карточку маркетплейса (сбор хотелок).',
    messages: 34,
  },
];

const mockAssets: Asset[] = [
  {
    id: 1,
    clientId: 1,
    orderId: 101,
    path: MOCK_IMG.input,
    mime: 'image/png',
    name: 'ref-sneakers.jpg',
    role: 'from_client',
    caption: 'Референс Nike Air для карточки кроссовок',
    tags: ['wb', 'обувь', 'референс'],
    createdAt: now - 5 * 3600_000,
  },
  {
    id: 2,
    clientId: 1,
    orderId: 103,
    path: MOCK_IMG.preview,
    mime: 'image/png',
    name: 'avatar-preview.png',
    role: 'preview',
    caption: 'Превью делового портрета для канала',
    tags: ['нейрофото', 'превью'],
    createdAt: now - 12 * 3600_000,
  },
  {
    id: 3,
    clientId: 1,
    orderId: 105,
    path: MOCK_IMG.output,
    mime: 'image/png',
    name: 'thermos-card.png',
    role: 'working',
    caption: 'Черновик инфографики термоса Ozon',
    tags: ['ozon', 'инфографика'],
    createdAt: now - 2 * 3600_000,
  },
  {
    id: 4,
    clientId: 1,
    orderId: 106,
    path: 'clients/1/brief-mvp.pdf',
    mime: 'application/pdf',
    name: 'brief-mvp.pdf',
    role: 'delivered',
    caption: 'Черновик ТЗ по MVP после голосового',
    tags: ['тз', 'документ'],
    createdAt: now - 86400_000,
  },
];

const mockPlans: Plan[] = [
  {
    id: 1,
    name: 'Старт',
    priceMonth: 990,
    tasksPerMonth: 5,
    description: 'Поиск, краткие поручения, напоминания — для редких задач.',
    enabled: true,
  },
  {
    id: 2,
    name: 'Ассистент',
    priceMonth: 2990,
    tasksPerMonth: 15,
    description: 'Исследования, подборки, тексты, контроль дедлайнов — основной тариф.',
    enabled: true,
  },
  {
    id: 3,
    name: 'Про',
    priceMonth: 5990,
    tasksPerMonth: 40,
    description: 'Расширенная квота поручений и приоритет на сложные исследования.',
    enabled: false,
  },
];

const mockSubscriptions: Subscription[] = [
  {
    id: 1,
    clientId: 1,
    planId: 2,
    status: 'active',
    periodStart: now - 10 * 86400_000,
    periodEnd: now + 20 * 86400_000,
    tasksUsed: 4,
    createdAt: now - 40 * 86400_000,
  },
  {
    id: 2,
    clientId: 2,
    planId: 1,
    status: 'pending',
    periodStart: null,
    periodEnd: null,
    tasksUsed: 0,
    createdAt: now - 2 * 86400_000,
  },
];

const mockPayments: Payment[] = [
  {
    id: 1,
    clientId: 1,
    purpose: 'subscription',
    orderId: null,
    subscriptionId: 1,
    amount: 2990,
    status: 'succeeded',
    providerId: 'yookassa-sub-1',
    url: null,
    createdAt: now - 40 * 86400_000,
    paidAt: now - 40 * 86400_000,
  },
  {
    id: 2,
    clientId: 1,
    purpose: 'order',
    orderId: 103,
    subscriptionId: null,
    amount: 1500,
    status: 'pending',
    providerId: 'yookassa-ord-103',
    url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=demo-wb-103',
    createdAt: now - 12 * 3600_000,
    paidAt: null,
  },
  {
    id: 3,
    clientId: 1,
    purpose: 'order',
    orderId: 104,
    subscriptionId: null,
    amount: 600,
    status: 'succeeded',
    providerId: 'yookassa-ord-104',
    url: null,
    createdAt: now - 5 * 86400_000,
    paidAt: now - 4 * 86400_000,
  },
  {
    id: 4,
    clientId: 2,
    purpose: 'subscription',
    orderId: null,
    subscriptionId: 2,
    amount: 990,
    status: 'pending',
    providerId: 'yookassa-sub-2',
    url: 'https://yoomoney.ru/checkout/payments/v2/contract?orderId=demo-sub-2',
    createdAt: now - 2 * 86400_000,
    paidAt: null,
  },
];

const msg2Date = now - 1.8 * 3600_000;
const msg5Date = now - 1 * 3600_000;

const mockAgentSteps: AgentStep[] = [
  {
    id: 1,
    leadId: 1,
    ts: msg2Date - 120_000,
    tool: 'search_memory',
    input: '{"query":"MVP Telegram бот"}',
    output: '[]',
    ok: true,
  },
  {
    id: 2,
    leadId: 1,
    ts: msg2Date - 60_000,
    tool: 'remember',
    input: '{"kind":"profile","text":"Главный сценарий — лента заказов"}',
    output: 'fact #7',
    ok: true,
  },
  {
    id: 3,
    leadId: 1,
    ts: msg2Date - 500,
    tool: 'reply',
    input: '{"text":"Алексей, добрый день!..."}',
    output: 'sent',
    ok: true,
  },
  {
    id: 4,
    leadId: 1,
    ts: msg5Date - 90_000,
    tool: 'remember',
    input: '{"kind":"deal","text":"Срок — полтора месяца"}',
    output: 'fact #4',
    ok: true,
  },
  {
    id: 5,
    leadId: 1,
    ts: msg5Date - 400,
    tool: 'reply',
    input: '{"text":"Понял, полтора месяца..."}',
    output: 'sent',
    ok: true,
  },
];

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

const builtinAgentDefaults: AgentDef[] = [
  {
    name: 'manager',
    description: 'Ведёт диалог с клиентом от имени помощника владельца, продаёт услуги и подписку',
    mode: 'primary',
    model: '',
    temperature: 0.4,
    steps: 8,
    needs: [],
    verify: 'off',
    check: '',
    permission: { '*': 'allow', request_payment: 'ask' },
    prompt:
      'Ты — помощник Кирилла. Собираешь заявку, продаёшь услуги из каталога, предлагаешь подписку. ' +
      'Пиши коротко, по одному вопросу. Цены — только внутри вилки. Передаёшь человеку, когда клиент просит цену вне каталога.',
    builtIn: true,
  },
  {
    name: 'researcher',
    description: 'Поиск в интернете и исследование со списком источников',
    mode: 'subagent',
    model: 'deepseek',
    temperature: 0.2,
    steps: 12,
    needs: ['research', 'russian'],
    verify: 'free',
    check: '',
    permission: { web_search: 'allow', fetch_url: 'allow', '*': 'deny' },
    prompt: 'Ты — исследователь. Ищи в сети, читай страницы, отвечай со ссылками на источники.',
    builtIn: true,
  },
];

const mockAgents: AgentDef[] = builtinAgentDefaults.map((a) => ({ ...a, permission: { ...a.permission } }));

let mockRules = '# Правила компании\n\n- Пишем коротко и по-человечески.\n- Не обещаем того, чего нет в каталоге.\n- Цены — только внутри вилки услуги.';

const mockSkills: SkillDef[] = [
  {
    name: 'wb-card',
    description: 'Карточка товара для Wildberries: SEO, характеристики, инфографика без запрещённых элементов',
    body: '# WB card\n\nСобери характеристики, SEO-название и описание. Не используй чужие логотипы.',
    status: 'active',
    source: 'builtin',
    uses: 14,
    lessons: ['Сразу спрашивай площадки и частоту постов — без этого план переделывают', 'Предлагай обложки к постам вместе с планом'],
    updatedAt: now,
  },
  {
    name: 'content-plan-week',
    description: 'Контент-план на неделю для малого бизнеса по нише и ссылкам',
    body: '# Content plan\n\n7 дней, форматы: пост, сторис, опрос. Укажи допущения по ЦА.',
    status: 'active',
    source: 'owner',
    uses: 6,
    lessons: [],
    updatedAt: now,
  },
  {
    name: 'supplier-search',
    description: 'Поиск поставщиков по городу и категории со сравнением цен',
    body: '# Supplier search\n\nНайди 3–5 поставщиков, сравни цены и сроки, выдай таблицу.',
    status: 'draft',
    source: 'learned',
    uses: 0,
    lessons: [],
    updatedAt: now,
  },
];

const mockSpamTemplates: SpamTemplate[] = [
  {
    id: 1,
    sample:
      'Всем привет! Нужно помочь с парой карточек. Оплата по результату. Пишите в личку — объясню все подробности',
    authors: 23,
    messages: 41,
    status: 'spam',
    source: 'auto',
    createdAt: now - 86_400_000,
    lastSeenAt: now - 600_000,
  },
  {
    id: 2,
    sample: 'Заработок без вложений — пиши + в личку, расскажу схему',
    authors: 8,
    messages: 12,
    status: 'allowed',
    source: 'owner',
    createdAt: now - 200_000_000,
    lastSeenAt: now - 3_600_000,
  },
];

const mockApprovals: Approval[] = [
  {
    id: 1,
    leadId: 1,
    agent: 'manager',
    tool: 'request_payment',
    input: '{"orderId":3}',
    summary: 'Выставить счёт 1500 ₽ за нейрофотосессию (10 образов)',
    status: 'pending',
    createdAt: now - 600_000,
    decidedAt: null,
  },
  {
    id: 2,
    leadId: 4,
    agent: 'manager',
    tool: 'send_asset',
    input: '{"assetId":2}',
    summary: 'Отправить клиенту пример портфолио (PDF)',
    status: 'approved',
    createdAt: now - 86400_000 * 2,
    decidedAt: now - 86400_000 * 2 + 120_000,
  },
];

const mockChats: ChatSummary[] = [
  {
    chatId: 101,
    title: 'Заказы на разработку',
    username: 'dev_orders_ru',
    kind: 'supergroup',
    memberCount: 12040,
    isMember: true,
    unreadCount: 2,
    lastText: 'Ищу разработчика на MVP мобильного приложения с интеграцией Telegram-бота',
    lastDate: now - 2 * 3600_000,
  },
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

function mockChatItems(chatId: number, centerMessageId?: number): ChatItem[] {
  if (chatId === 101) {
    const leadText =
      'Ищу разработчика на MVP мобильного приложения с интеграцией Telegram-бота. Бюджет обсуждаем, сроки 6–8 недель.';
    const base = now - 3 * 3600_000;
    const thread: [number, string, string, boolean][] = [
      [8798, 'Олег', 'Кто делает лендинги под запуск курса?', false],
      [8799, 'Анна', 'Могу порекомендовать студию', false],
      [8800, 'Игорь', 'Ищу верстальщика на Tilda', false],
      [8801, 'Алексей Морозов', leadText, false],
      [8802, 'Модератор', 'Пожалуйста, без спама в чате', false],
      [8803, 'Кирилл', 'Алексей, ответил в личку', true],
    ];
    let list = thread.map(([messageId, name, text, out]) => ({
      messageId,
      date: base + (messageId - 8798) * 12 * 60_000,
      text,
      senderName: name,
      senderUsername: name === 'Алексей Морозов' ? 'alexm_dev' : null,
      isOutgoing: out,
      voice: null,
      replyToMessageId: null,
      link: messageId === 8801 ? 'https://t.me/dev_orders_ru/8801' : null,
    }));
    if (centerMessageId != null) {
      const idx = list.findIndex((m) => m.messageId === centerMessageId);
      if (idx >= 0) list = list.slice(Math.max(0, idx - 2), idx + 3);
    }
    return list;
  }
  const base = now - 3 * 3600_000;
  const lines: [string, string, boolean][] = [
    ['Олег', 'Всем привет! Кто может сделать лендинг под запуск курса за неделю?', false],
    ['Анна', 'Посмотрите портфолио у @studio_landing, делали похожее', false],
    ['Кирилл', 'Олег, могу взяться — напишите в личку детали', true],
    ['Игорь', 'Ищу разработчика на Telegram-бота для записи клиентов, бюджет 40–60к', false],
  ];
  return lines.map(([name, text, out], i) => ({
    messageId: Math.abs(chatId) * 100 + i + 1,
    date: base + i * 40 * 60_000,
    text,
    senderName: name,
    senderUsername: null,
    isOutgoing: out,
    voice: i === 1 ? { fileId: 9, durationSec: 7 } : null,
    replyToMessageId: null,
    link: null,
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
        const p: Project = { id: nid(), ...input, agent: input.agent ?? '', autopilot: makeAutopilot(), createdAt: Date.now() };
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
      async list(search) {
        await delay(40);
        let list = mockClients.map((c) => ({ ...c, leadIds: [...c.leadIds] }));
        if (search) {
          const q = search.toLowerCase();
          list = list.filter(
            (c) => c.name.toLowerCase().includes(q) || (c.username ?? '').toLowerCase().includes(q),
          );
        }
        return list;
      },
      async get(id) {
        await delay(30);
        const c = mockClients.find((x) => x.id === id);
        if (!c) throw new Error('Клиент не найден');
        return { ...c, leadIds: [...c.leadIds] };
      },
      async byLead(leadId) {
        await delay(30);
        const l = leads.find((x) => x.id === leadId);
        if (l?.clientId != null) {
          const c = mockClients.find((x) => x.id === l.clientId);
          return c ? { ...c, leadIds: [...c.leadIds] } : null;
        }
        const c = mockClients.find((x) => x.leadIds.includes(leadId));
        return c ? { ...c, leadIds: [...c.leadIds] } : null;
      },
    },
    memory: {
      async facts(clientId) {
        await delay(40);
        return mockFacts.filter((f) => f.clientId === clientId).map((f) => ({ ...f }));
      },
      async addFact(clientId, kind, text) {
        await delay(60);
        const f: MemoryFact = {
          id: nid(),
          clientId,
          kind,
          text,
          source: 'владелец',
          active: true,
          createdAt: Date.now(),
        };
        mockFacts.push(f);
        emit({ type: 'memory:update', clientId });
        return { ...f };
      },
      async removeFact(factId) {
        await delay(40);
        const f = mockFacts.find((x) => x.id === factId);
        if (f) {
          f.active = false;
          emit({ type: 'memory:update', clientId: f.clientId });
        }
      },
      async episodes(clientId) {
        await delay(40);
        return mockEpisodes.filter((e) => e.clientId === clientId).map((e) => ({ ...e }));
      },
      async assets(clientId, query) {
        await delay(query ? 120 : 40);
        let list = mockAssets.filter((a) => a.clientId === clientId);
        if (query?.trim()) {
          const q = query.toLowerCase();
          list = list.filter(
            (a) =>
              a.caption.toLowerCase().includes(q) ||
              a.name.toLowerCase().includes(q) ||
              a.tags.some((t) => t.toLowerCase().includes(q)),
          );
        }
        return list.map((a) => ({ ...a, tags: [...a.tags] }));
      },
      async sendAsset(leadId, assetId) {
        await delay(200);
        const a = mockAssets.find((x) => x.id === assetId);
        if (!a) throw new Error('Файл не найден');
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: 1,
          direction: 'out',
          where: 'dm',
          kind: 'text',
          text: `Отправил файл: ${a.caption || a.name}`,
          mediaPath: a.path,
          durationSec: null,
          tgChatId: l.tgChatId,
          tgMessageId: nid(),
          date: Date.now(),
          auto: true,
        };
        messages.push(msg);
        emit({ type: 'message:new', message: { ...msg } });
      },
    },
    billing: {
      async plans() {
        await delay(40);
        return mockPlans.map((p) => ({ ...p }));
      },
      async savePlan(plan) {
        await delay(80);
        if (plan.id != null) {
          const p = mockPlans.find((x) => x.id === plan.id);
          if (!p) throw new Error('Тариф не найден');
          Object.assign(p, plan);
          return { ...p };
        }
        const p: Plan = { ...plan, id: nid() };
        mockPlans.push(p);
        return { ...p };
      },
      async removePlan(planId) {
        const i = mockPlans.findIndex((x) => x.id === planId);
        if (i >= 0) mockPlans.splice(i, 1);
      },
      async subscriptions(clientId) {
        await delay(40);
        const list = clientId == null ? mockSubscriptions : mockSubscriptions.filter((s) => s.clientId === clientId);
        return list.map((s) => ({ ...s }));
      },
      async subscribe(clientId, planId) {
        await delay(300);
        const plan = mockPlans.find((p) => p.id === planId);
        if (!plan) throw new Error('Тариф не найден');
        const sub: Subscription = {
          id: nid(),
          clientId,
          planId,
          status: 'pending',
          periodStart: null,
          periodEnd: null,
          tasksUsed: 0,
          createdAt: Date.now(),
        };
        mockSubscriptions.push(sub);
        const pay: Payment = {
          id: nid(),
          clientId,
          purpose: 'subscription',
          orderId: null,
          subscriptionId: sub.id,
          amount: plan.priceMonth,
          status: 'pending',
          providerId: `yookassa-sub-${sub.id}`,
          url: `https://yoomoney.ru/checkout/payments/v2/contract?orderId=demo-sub-${sub.id}`,
          createdAt: Date.now(),
          paidAt: null,
        };
        mockPayments.unshift(pay);
        emit({ type: 'billing:update', clientId });
        return { ...sub };
      },
      async cancelSubscription(subscriptionId) {
        await delay(120);
        const s = mockSubscriptions.find((x) => x.id === subscriptionId);
        if (!s) throw new Error('Подписка не найдена');
        s.status = 'canceled';
        emit({ type: 'billing:update', clientId: s.clientId });
        return { ...s };
      },
      async payments(clientId) {
        await delay(40);
        const list = clientId == null ? mockPayments : mockPayments.filter((p) => p.clientId === clientId);
        return list.map((p) => ({ ...p }));
      },
      async checkPayment(paymentId) {
        await delay(400);
        const p = mockPayments.find((x) => x.id === paymentId);
        if (!p) throw new Error('Платёж не найден');
        if (p.status === 'pending') {
          p.status = 'succeeded';
          p.paidAt = Date.now();
          if (p.subscriptionId != null) {
            const sub = mockSubscriptions.find((s) => s.id === p.subscriptionId);
            if (sub) {
              sub.status = 'active';
              sub.periodStart = Date.now();
              sub.periodEnd = Date.now() + 30 * 86400_000;
            }
          }
        }
        emit({ type: 'billing:update', clientId: p.clientId });
        return { ...p };
      },
    },
    agents: {
      async list() {
        return mockAgents.map((a) => ({ ...a, permission: { ...a.permission } }));
      },
      async save(def) {
        const i = mockAgents.findIndex((a) => a.name === def.name);
        if (i >= 0) mockAgents[i] = { ...def };
        else mockAgents.push({ ...def });
        return { ...def };
      },
      async remove(name) {
        const built = builtinAgentDefaults.find((a) => a.name === name);
        if (built) {
          const i = mockAgents.findIndex((a) => a.name === name);
          if (i >= 0) mockAgents[i] = { ...built, permission: { ...built.permission } };
          return;
        }
        const i = mockAgents.findIndex((a) => a.name === name && !a.builtIn);
        if (i >= 0) mockAgents.splice(i, 1);
      },
      async rules() {
        return mockRules;
      },
      async saveRules(text) {
        mockRules = text;
        return text;
      },
    },
    skills: {
      async list() {
        return mockSkills.map((x) => ({ ...x }));
      },
      async save(skill) {
        const v = { ...skill, uses: 0, lessons: mockSkills.find((x) => x.name === skill.name)?.lessons ?? [], updatedAt: Date.now() };
        const i = mockSkills.findIndex((x) => x.name === skill.name);
        if (i >= 0) mockSkills[i] = v;
        else mockSkills.push(v);
        return { ...v };
      },
      async remove(name) {
        const i = mockSkills.findIndex((x) => x.name === name);
        if (i >= 0) mockSkills.splice(i, 1);
      },
      async removeLesson(name, index) {
        const v = mockSkills.find((x) => x.name === name)!;
        v.lessons = v.lessons.filter((_, i) => i !== index);
        return { ...v };
      },
      async approve(name) {
        const v = mockSkills.find((x) => x.name === name)!;
        v.status = 'active';
        return { ...v };
      },
    },
    spam: {
      async templates() {
        return mockSpamTemplates.map((t) => ({ ...t }));
      },
      async markSpam(leadId) {
        const l = leads.find((x) => x.id === leadId)!;
        const t = { id: nid(), sample: l.text, authors: 1, messages: 1, status: 'spam' as const, source: 'owner' as const, createdAt: Date.now(), lastSeenAt: Date.now() };
        mockSpamTemplates.unshift(t);
        Object.assign(l, { spamTemplateId: t.id, status: 'hidden' });
        return { ...l };
      },
      async setTemplateStatus(id, status) {
        const t = mockSpamTemplates.find((x) => x.id === id)!;
        t.status = status;
        return { ...t };
      },
      async chats() {
        return mockSpamChats.map((c) => ({ ...c }));
      },
      async blockChat(_accountId, chatId) {
        const c = { tgChatId: chatId, title: `Чат ${chatId}`, username: null, reason: 'отмечен вручную', messages: 0, liveShare: 0, source: 'owner' as const, createdAt: Date.now() };
        mockSpamChats.unshift(c);
        return { ...c };
      },
      async unblockChat(tgChatId) {
        const i = mockSpamChats.findIndex((c) => c.tgChatId === tgChatId);
        if (i >= 0) mockSpamChats.splice(i, 1);
      },
    },
    channels: {
      async desks() {
        return mockDesks;
      },
      async createDesk(accountId, link) {
        const d: ChannelDesk = { ...mockDesks[0], id: Date.now(), chatId: -Date.now(), title: link.replace(/.*\//, ''), username: link.replace(/.*\//, ''), accountId };
        mockDesks.push(d);
        return d;
      },
      async createChannel(accountId, opts) {
        const d: ChannelDesk = { ...mockDesks[0], id: Date.now(), chatId: -Date.now(), title: opts.title, username: opts.username ?? null, accountId };
        mockDesks.push(d);
        return d;
      },
      async saveDesk(d) {
        mockDesks.splice(mockDesks.findIndex((x) => x.id === d.id), 1, d);
        return mockDesks;
      },
      async removeDesk(id) {
        mockDesks.splice(mockDesks.findIndex((x) => x.id === id), 1);
        return mockDesks;
      },
      async sources(deskId) {
        return mockChannelSources.filter((s) => s.deskId === deskId);
      },
      async saveSource(src) {
        mockChannelSources.push({ ...src, id: Date.now(), lastRunAt: null, lastError: null, found: 0, createdAt: Date.now() } as ChannelSource);
        return mockChannelSources.filter((s) => s.deskId === src.deskId);
      },
      async removeSource(id) {
        mockChannelSources.splice(mockChannelSources.findIndex((s) => s.id === id), 1);
      },
      async runSource() {
        return 3;
      },
      async findTelegram(_accountId, query) {
        return [{ title: `${query} — noticias`, username: 'city_news_demo', members: 12400 }];
      },
      async browserLogin() {},
      async items(deskId) {
        return mockChannelItems.filter((i) => i.deskId === deskId);
      },
      async stories(deskId, status) {
        return mockChannelItems.filter((i) => i.deskId === deskId && i.status === status).map((i) => ({
          id: i.id, title: i.title, text: i.text, kind: i.kind, category: i.category, score: i.score, local: i.local, audiences: i.audiences, status: i.status, publishedAt: i.publishedAt,
          items: [{ id: i.id, sourceTitle: i.sourceTitle, title: i.title, url: i.url, publishedAt: i.publishedAt }],
        }));
      },
      async setStoryStatus(storyId, status) {
        const it = mockChannelItems.find((i) => i.id === storyId);
        if (it) it.status = status;
      },
      async feedStats() {
        return { items: 51, stories: 38, duplicates: 13, kept: 17, byCategory: { 'city.transport': 3, 'deals.food': 2 }, byAudience: { evening: 2, free: 1 }, sources: mockChannelSources.map((x) => ({ sourceId: x.id, title: x.title, kind: x.kind, items: 20, first: 14, duplicates: 6, kept: 8 })) };
      },
      async schedule(id, at) {
        const p = mockChannelPosts.find((x) => x.id === id)!;
        p.scheduledAt = at;
        return p;
      },
      async calendar() {
        const day = new Date();
        const at = (d: number, h: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + d, h).getTime();
        return [
          { at: at(0, 9), slot: mockDesks[0].slots[0], slotKey: null, post: mockChannelPosts[0] ?? null, state: mockChannelPosts[0] ? 'published' : 'missed', ready: null },
          { at: at(0, 19), slot: mockDesks[0].slots[1], slotKey: null, post: null, state: 'planned', ready: 4 },
          { at: at(1, 9), slot: mockDesks[0].slots[0], slotKey: null, post: null, state: 'planned', ready: 6 },
        ];
      },
      async rescore() {
        return 12;
      },
      async setItemStatus(id, status) {
        const it = mockChannelItems.find((i) => i.id === id);
        if (it) it.status = status;
      },
      async posts(deskId) {
        return mockChannelPosts.filter((p) => p.deskId === deskId);
      },
      async compose(deskId, kind) {
        const p: ChannelPost = { id: Date.now(), deskId, kind, text: '**🌆 Sevilla hoy**\n\n- Nueva línea de metro abre el lunes. [Fuente](https://example.com)', image: null, itemIds: [], status: 'draft', scheduledAt: null, slotKey: null, error: null, messageId: null, publishedAt: null, createdAt: Date.now() };
        mockChannelPosts.unshift(p);
        return p;
      },
      async savePost(id, text) {
        const p = mockChannelPosts.find((x) => x.id === id)!;
        p.text = text;
        return p;
      },
      async publish(id) {
        const p = mockChannelPosts.find((x) => x.id === id)!;
        Object.assign(p, { status: 'published', publishedAt: Date.now(), messageId: 101 });
        return p;
      },
      async setAvatar() {},
      async cloneForCity(_from, accountId, city) {
        const d: ChannelDesk = { ...mockDesks[0], id: Date.now(), chatId: -Date.now(), title: `${city} hoy`, username: null, accountId, area: city, autopublish: false };
        mockDesks.push(d);
        return { desk: d, sources: 9, rejected: [] };
      },
      async redrawCover(id) {
        return mockChannelPosts.find((x) => x.id === id)!;
      },
      async unpublish(id) {
        const p = mockChannelPosts.find((x) => x.id === id)!;
        p.status = 'rejected';
        return p;
      },
      async rejectPost(id) {
        const p = mockChannelPosts.find((x) => x.id === id);
        if (p) p.status = 'rejected';
      },
    },
    assistants: {
      async status() {
        return { tools: true, claude: { skill: true, cli: true }, codex: { skill: false, cli: false, mcp: false }, mcpCommand: '~/.local/bin/tgs-mcp', mcpConfig: '{\n  "mcpServers": {\n    "tg-search": { "command": "~/.local/bin/tgs-mcp" }\n  }\n}' };
      },
      async install(target) {
        return ['Команды tgs и tgs-mcp — в ~/.local/bin', `Навык tg-search — в ~/.${target}/skills/tg-search`, 'MCP-сервер tg-search добавлен'];
      },
      async installTools() {
        return ['Команды tgs и tgs-mcp — в ~/.local/bin'];
      },
    },
    knowledge: {
      async bases() {
        return mockKnowledgeBases;
      },
      async createBase(name, description) {
        mockKnowledgeBases.push({ id: mockKnowledgeBases.length + 1, name, description, docs: 0, chunks: 0, createdAt: Date.now() });
        return mockKnowledgeBases;
      },
      async updateBase(id, patch) {
        Object.assign(mockKnowledgeBases.find((b) => b.id === id) ?? {}, patch);
        return mockKnowledgeBases;
      },
      async removeBase(id) {
        mockKnowledgeBases.splice(mockKnowledgeBases.findIndex((b) => b.id === id), 1);
        return mockKnowledgeBases;
      },
      async docs(baseId) {
        return mockKnowledgeDocs.filter((d) => d.baseId === baseId);
      },
      async addFiles() {
        return [];
      },
      async addUrl(baseId, url) {
        const d: KnowledgeDoc = { id: Date.now(), baseId, title: url, source: url, chars: 12000, chunks: 11, embedded: 3, status: 'indexing', error: null, createdAt: Date.now() };
        mockKnowledgeDocs.unshift(d);
        return d;
      },
      async addText(baseId, title, text) {
        const d: KnowledgeDoc = { id: Date.now(), baseId, title, source: 'вставлен текст', chars: text.length, chunks: 1, embedded: 1, status: 'ready', error: null, createdAt: Date.now() };
        mockKnowledgeDocs.unshift(d);
        return d;
      },
      async removeDoc(docId) {
        mockKnowledgeDocs.splice(mockKnowledgeDocs.findIndex((d) => d.id === docId), 1);
      },
      async search() {
        return [{ docTitle: 'Справка Яндекс Директа', source: 'https://yandex.ru/support/direct/', heading: 'Ставки › Автостратегии', text: 'Автостратегия «Максимум кликов» сама подбирает ставки в пределах недельного бюджета…' }];
      },
    },
    helper: {
      async chats() {
        return mockHelperChats;
      },
      async addChat(accountId, link) {
        mockHelperChats.push({ chatId: -100777, title: link.replace(/.*\//, ''), username: link.replace(/.*\//, ''), accountId, enabled: true });
        return mockHelperChats;
      },
      async saveChats(list) {
        mockHelperChats.splice(0, mockHelperChats.length, ...list);
        return mockHelperChats;
      },
      async preview(_chat, text) {
        return { answer: `## Ответ\nНа «${text}» помощник ответил бы так.\n\n**Итог:** пример ответа из демо-данных`, ms: 8400 };
      },
      async test(_chat, text, scenario) {
        const threshold = scenario?.threshold ?? 0.5;
        const score = /реши|задач|\?/i.test(text) ? 0.86 : 0.08;
        return { score, answer: score >= threshold, reason: `Jev: ${Math.round(score * 100)}% при пороге ${Math.round(threshold * 100)}%` };
      },
      async scenarios() {
        return mockScenarios;
      },
      async saveScenario(def) {
        const id = def.id || `sc-${Date.now()}`;
        const i = mockScenarios.findIndex((x) => x.id === id);
        if (i >= 0) mockScenarios[i] = { ...def, id };
        else mockScenarios.push({ ...def, id, builtIn: false });
        return mockScenarios;
      },
      async removeScenario(id) {
        const i = mockScenarios.findIndex((x) => x.id === id);
        if (i >= 0 && !mockScenarios[i].builtIn) mockScenarios.splice(i, 1);
        return mockScenarios;
      },
      async requests() {
        return [
          { id: 2, chatId: -1001234567890, messageId: 41, accountId: 1, userId: 9, userName: 'Аня', text: '', photos: ['/tmp/p.jpg'], tasks: ['1', '2', '3'], selection: 'all', status: 'done', error: null, createdAt: Date.now() - 600_000, updatedAt: Date.now() - 300_000, score: 0.93, agent: 'solver', answer: '## Задача 1\n> Найдите x: 2x + 3 = 11\n\n1. Переносим 3: $2x = 8$\n2. Делим на 2: $x = 4$\n\n**Ответ: 4**' },
          { id: 1, chatId: -1001234567890, messageId: 40, accountId: 1, userId: 8, userName: 'Петя', text: 'всем привет', photos: [], tasks: [], selection: null, status: 'ignored', error: null, createdAt: Date.now() - 900_000, updatedAt: Date.now() - 900_000, score: 0.04, agent: null, answer: null },
        ] as HelperRequest[];
      },
    },
    ai: {
      async status() {
        return { state: 'ready' as const, version: '2.1.2', latest: '2.1.2', url: 'http://127.0.0.1:0', message: null, checkedAt: Date.now() };
      },
      async models() {
        return mockAiModels();
      },
      async setModels({ main, helpers, useFree }) {
        mockAiChoice.main = main;
        mockAiChoice.helpers = helpers;
        if (useFree !== undefined) mockAiChoice.useFree = useFree;
        return mockAiModels();
      },
      async providers() {
        return mockAiProviders.map((p) => ({ ...p }));
      },
      async saveProvider(p) {
        const v = { id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL ?? null, hasKey: !!p.apiKey || !!mockAiProviders.find((x) => x.id === p.id)?.hasKey, models: p.models?.length ?? 0 };
        const i = mockAiProviders.findIndex((x) => x.id === p.id);
        if (i >= 0) mockAiProviders[i] = v;
        else mockAiProviders.push(v);
        return mockAiProviders.map((x) => ({ ...x }));
      },
      async removeProvider(id) {
        const i = mockAiProviders.findIndex((x) => x.id === id);
        if (i >= 0) mockAiProviders.splice(i, 1);
        return mockAiProviders.map((x) => ({ ...x }));
      },
      async importOpencode() {
        return 7;
      },
      async checkUpdate() {
        return 'OpenCode 2.1.2 — последняя версия';
      },
      async stats() {
        return [
          { model: 'router9/ag/gemini-3.8-flash-high', agent: 'solver', runs: 12, ok: 10, failed: 0, rejected: 1, redone: 1, clientFixes: 0, avgScore: 0.88, avgMs: 41000 },
          { model: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', agent: 'solver', runs: 7, ok: 4, failed: 1, rejected: 2, redone: 0, clientFixes: 0, avgScore: 0.71, avgMs: 63000 },
        ];
      },
      async route() {
        return {
          role: 'smart', needs: ['reasoning'], order: ['openrouter/google/gemma-4-31b-it:free', 'openlux-claude/claude-sonnet-5-5'],
          ranked: [{ ref: 'openrouter/google/gemma-4-31b-it:free', name: 'Google: Gemma 4 31B (free)', p: 0.62 }],
        };
      },
    },
    trusted: {
      async list() {
        return mockTrusted.map((c) => ({ ...c }));
      },
      async save(c) {
        const username = c.username.replace(/^@/, '').toLowerCase();
        const prev = mockTrusted.find((x) => x.username === username);
        const v = { username, userId: prev?.userId ?? null, free: c.free ?? true, dailyCheckin: c.dailyCheckin ?? false, checkinHour: c.checkinHour ?? 11, lastCheckinAt: prev?.lastCheckinAt ?? null, note: c.note ?? '' };
        if (prev) Object.assign(prev, v);
        else mockTrusted.push(v);
        return { ...v };
      },
      async remove(username) {
        const i = mockTrusted.findIndex((x) => x.username === username);
        if (i >= 0) mockTrusted.splice(i, 1);
      },
      async checkinNow() {},
    },
    news: {
      async channels() {
        return mockNewsChannels.map((c) => ({ ...c }));
      },
      async addChannel(link) {
        const c = { id: nid(), tgChatId: -1009100 - mockNewsChannels.length, title: link.replace(/^.*[/@]/, ''), username: link.replace(/^.*[/@]/, ''), enabled: true, lastMessageId: 0, lastCheckedAt: null, createdAt: Date.now() };
        mockNewsChannels.push(c);
        return { ...c };
      },
      async updateChannel(id, patch) {
        const c = mockNewsChannels.find((x) => x.id === id)!;
        Object.assign(c, patch);
        return { ...c };
      },
      async removeChannel(id) {
        const i = mockNewsChannels.findIndex((x) => x.id === id);
        if (i >= 0) mockNewsChannels.splice(i, 1);
      },
      async items(status = 'new') {
        return mockNewsItems.filter((x) => (status === 'all' ? x.status !== 'dismissed' : x.status === status)).map((x) => ({ ...x }));
      },
      async setStatus(id, status) {
        const x = mockNewsItems.find((n) => n.id === id)!;
        x.status = status;
        return { ...x };
      },
      async draft(id, kind) {
        const x = mockNewsItems.find((n) => n.id === id)!;
        x.status = 'used';
        return kind === 'repost' ? `${x.summary}\n\nИсточник: ${x.link}` : `Обзор: ${x.summary} ${x.why}\n\nИсточник: ${x.link}`;
      },
      async runNow() {
        return 0;
      },
    },
    approvals: {
      async list(status) {
        return mockApprovals.filter((a) => !status || a.status === status).map((a) => ({ ...a }));
      },
      async decide(id, approve) {
        const a = mockApprovals.find((x) => x.id === id)!;
        Object.assign(a, { status: approve ? 'approved' : 'denied', decidedAt: Date.now() });
        const copy = { ...a };
        emit({ type: 'approval:update', approval: copy });
        return copy;
      },
    },
    agent: {
      async trace(leadId, limit = 50) {
        await delay(30);
        return mockAgentSteps
          .filter((s) => s.leadId === leadId)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, limit)
          .map((s) => ({ ...s }));
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
      async resolveLink(_accountId, url) {
        const m = /t\.me\/([A-Za-z0-9_]+)(?:\/(\d+))?/.exec(url);
        return { chat: { chatId: -1009101, title: m?.[1] ?? 'Чат', username: m?.[1] ?? null, kind: 'channel' as const, memberCount: 9000, isMember: false }, messageId: m?.[2] ? Number(m[2]) : null };
      },
      async discussion() {
        return { chatId: -1009002, title: 'Обсуждение канала', username: null, kind: 'supergroup' as const, memberCount: 320, isMember: false };
      },
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
          messageId: Date.now(), date: Date.now(), text, senderName: 'Кирилл', senderUsername: 'owner_work', isOutgoing: true,
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
      async around(_accountId, chatId, messageId) {
        await delay(150);
        return mockChatItems(chatId, messageId);
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

import type {
  Account,
  Api,
  AppEvent,
  AutopilotSettings,
  ChatMessage,
  ClientCard,
  Lead,
  LeadFilter,
  LoginState,
  Project,
  ProjectInput,
  Settings,
  Source,
} from '../../shared/types';
import { DEFAULT_AUTOPILOT, DEFAULT_MANAGER } from '../../shared/types';

const leadExtra = { sequenceStep: 0, nextStepAt: null, handoff: false, handoffReason: null };

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mockCard(leadId: number): ClientCard {
  return {
    leadId, stage: 'discovery', summary: 'Клиент запускает студию йоги, нужен сайт с расписанием и онлайн-записью. Сроки — месяц.',
    anamnesis: {
      task: 'Сайт студии йоги с расписанием и онлайн-записью', goal: 'Запись клиентов без звонков', audience: 'Жители района, 25–45 лет',
      features: ['Расписание занятий', 'Онлайн-запись', 'Оплата абонементов'], integrations: ['ЮKassa'], stack: ['Next.js', 'Supabase'],
      deadline: 'Открытие через месяц', budget: 'Не назван', references: [], contacts: '', openQuestions: ['Бюджет', 'Нужен ли личный кабинет'],
    },
    brief: '', notes: '', completeness: 60, updatedAt: Date.now(), briefUpdatedAt: null,
  };
}

const now = Date.now();
const day = new Date().toISOString().slice(0, 10);

let settings: Settings = {
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmApiKey: '',
  llmModel: 'anthropic/claude-haiku-5.5',
  jevBaseUrl: 'https://api.openlux.ai/v1',
  jevApiKey: '',
  jevModel: 'jev-1.14.0', handoffNotifyTo: '', ownerName: 'Кирилл', sttBaseUrl: '', sttApiKey: '', sttModel: '', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '',
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

function makeAutopilot(partial?: Partial<AutopilotSettings>): AutopilotSettings {
  return {
    ...DEFAULT_AUTOPILOT,
    enabled: false,
    nextRunAt: now + 45 * 60_000,
    lastRunAt: now - 2 * 3600_000,
    ...partial,
  };
}

const projects: Project[] = [
  {
    id: 1,
    name: 'Клиенты на разработку',
    task: 'clients',
    target: 'Стартапы и малый бизнес, которым нужен MVP или автоматизация',
    offer: 'Разработка на TypeScript, Electron, интеграции с Telegram и CRM',
    geo: ['Россия', 'СНГ'],
    languages: ['русский'],
    accountIds: [1, 2],
    materials: [{ kind: 'url', value: 'https://example.com/portfolio' }],
    keywords: ['нужен разработчик', 'mvp telegram', 'автоматизация бизнеса'],
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot({ enabled: true, scanIntervalMin: 60, aiReply: true, minScore: 85 }),
    createdAt: now - 30 * 86400_000,
  },
  {
    id: 2,
    name: 'Маркетинг · новые клиенты',
    task: 'clients',
    target: 'Маркетологи и владельцы бизнеса, ищущие подрядчика по трафику',
    offer: 'Performance и контент для B2B',
    geo: ['Москва'],
    languages: ['русский'],
    accountIds: [1],
    materials: [],
    keywords: ['ищу маркетолога', 'настройка рекламы'],
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot({ enabled: false }),
    createdAt: now - 20 * 86400_000,
  },
  {
    id: 3,
    name: 'Партнёры · интеграторы',
    task: 'partners',
    target: 'Агентства и студии для партнёрских проектов',
    offer: 'White-label разработка',
    geo: [],
    languages: ['русский', 'английский'],
    accountIds: [1],
    materials: [],
    keywords: ['партнёрство разработка'],
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot(),
    createdAt: now - 15 * 86400_000,
  },
  {
    id: 4,
    name: 'Инвесторы · pre-seed',
    task: 'investors',
    target: 'Ангелы и фонды на ранней стадии',
    offer: 'SaaS для лидогенерации в Telegram',
    geo: ['глобально'],
    languages: ['английский'],
    accountIds: [2],
    materials: [],
    keywords: ['ищу инвестиции saas'],
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot(),
    createdAt: now - 10 * 86400_000,
  },
  {
    id: 5,
    name: 'Вакансии · разработчики',
    task: 'jobs',
    target: 'Middle+ разработчики TypeScript/React',
    offer: 'Удалёнка, проект TG Search',
    geo: ['Россия'],
    languages: ['русский'],
    accountIds: [1],
    materials: [],
    keywords: ['ищу работу typescript', 'react удалённо'],
    criteria: '',
    sequence: [],
    manager: DEFAULT_MANAGER,
    autopilot: makeAutopilot({ enabled: true, refreshSources: true }),
    createdAt: now - 5 * 86400_000,
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
    foundBy: 'mvp telegram',
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
    title: 'Фриланс IT чат',
    username: null,
    kind: 'group',
    memberCount: 3200,
    status: 'candidate',
    foundBy: 'автоматизация бизнеса',
    accountId: 2,
    checkedLeads: 8,
    matchedLeads: 1,
    lastScannedAt: null,
    lastMessageId: null,
    createdAt: now - 3 * 86400_000,
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
    text: 'Ищу разработчика на MVP мобильного приложения с интеграцией Telegram-бота. Бюджет обсуждаем, сроки 6–8 недель. Нужен опыт с TypeScript и API.',
    date: now - 2 * 3600_000,
    link: 'https://t.me/dev_orders_ru/8801',
    score: 96,
    label: 'demand',
    reason: 'Прямой запрос на разработку MVP с Telegram — совпадает с оффером.',
    ...leadExtra,
    feedback: 'up',
    status: 'dialog',
    accountId: 1,
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
    text: 'Кто может автоматизировать выгрузку лидов из чатов в CRM? Есть HubSpot, нужен надёжный пайплайн без ручной работы.',
    date: now - 5 * 3600_000,
    link: 'https://t.me/dev_orders_ru/8790',
    score: 91,
    label: 'demand',
    reason: 'Запрос на автоматизацию лидов — близко к продукту.',
    ...leadExtra,
    feedback: null,
    status: 'replied',
    accountId: 1,
    createdAt: now - 5 * 3600_000,
  },
  {
    id: 3,
    projectId: 1,
    sourceId: 2,
    tgChatId: 102,
    tgMessageId: 4390,
    authorUserId: null,
    authorName: 'Стартапы РФ',
    authorUsername: 'startup_rf',
    text: 'Основатель edtech-стартапа ищет техлида на part-time для доработки личного кабинета. Стек React + Node.',
    date: now - 86400_000,
    link: 'https://t.me/startup_rf/4390',
    score: 78,
    label: 'interest',
    reason: 'Интерес к разработке, но контакт через канал.',
    ...leadExtra,
    feedback: null,
    status: 'new',
    accountId: null,
    createdAt: now - 86400_000,
  },
  {
    id: 4,
    projectId: 1,
    sourceId: 1,
    tgChatId: 101,
    tgMessageId: 8770,
    authorUserId: 5004,
    authorName: 'Дмитрий',
    authorUsername: 'dmitry_saas',
    text: 'Нужен подрядчик на поддержку Electron-приложения, баги и мелкие фичи. Долгосрочно.',
    date: now - 2 * 86400_000,
    link: 'https://t.me/dev_orders_ru/8770',
    score: 88,
    label: 'demand',
    reason: 'Electron — прямое попадание в стек.',
    ...leadExtra,
    feedback: 'up',
    status: 'new',
    accountId: null,
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
    text: 'Подскажите, кто делает чат-ботов для записи в салон? Не разработка с нуля, а доработка.',
    date: now - 3 * 86400_000,
    link: 'https://t.me/dev_orders_ru/8760',
    score: 62,
    label: 'interest',
    reason: 'Смежная тема, но не core-оффер.',
    ...leadExtra,
    feedback: 'down',
    status: 'hidden',
    accountId: null,
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
    text: 'Ищу маркетолога на настройку Яндекс и VK для B2B услуг.',
    date: now - 4 * 3600_000,
    link: null,
    score: 84,
    label: 'demand',
    reason: 'Запрос на маркетинг.',
    ...leadExtra,
    feedback: null,
    status: 'new',
    accountId: null,
    createdAt: now - 4 * 3600_000,
  },
];

const messages: ChatMessage[] = [
  {
    id: 1,
    leadId: 1,
    accountId: null,
    direction: 'in',
    where: 'chat',
    kind: 'text',
    mediaPath: null,
    durationSec: null,
    text: 'Ищу разработчика на MVP мобильного приложения с интеграцией Telegram-бота. Бюджет обсуждаем, сроки 6–8 недель.',
    tgChatId: 101,
    tgMessageId: 8801,
    date: now - 2 * 3600_000,
    auto: false,
  },
  {
    id: 2,
    leadId: 1,
    accountId: 1,
    direction: 'out',
    where: 'dm',
    kind: 'text',
    mediaPath: null,
    durationSec: null,
    text: 'Алексей, добрый день! Делал похожие MVP на TypeScript — могу коротко созвониться и оценить объём?',
    tgChatId: 5001,
    tgMessageId: 90001,
    date: now - 1.5 * 3600_000,
    auto: true,
  },
  {
    id: 3,
    leadId: 1,
    accountId: null,
    direction: 'in',
    where: 'dm',
    kind: 'text',
    mediaPath: null,
    durationSec: null,
    text: 'Да, напишите в личку удобное время сегодня вечером.',
    tgChatId: 5001,
    tgMessageId: 90002,
    date: now - 1 * 3600_000,
    auto: false,
  },
];

const listeners = new Set<(e: AppEvent) => void>();

function emit(e: AppEvent) {
  listeners.forEach((cb) => cb(e));
}

let nextId = 1000;
const nid = () => ++nextId;

function filterLeads(projectId: number, filter?: LeadFilter): Lead[] {
  let list = leads.filter((l) => l.projectId === projectId);
  if (filter?.search) {
    const q = filter.search.toLowerCase();
    list = list.filter(
      (l) =>
        l.text.toLowerCase().includes(q) ||
        l.authorName?.toLowerCase().includes(q) ||
        l.authorUsername?.toLowerCase().includes(q),
    );
  }
  if (filter?.status && filter.status !== 'all') {
    list = list.filter((l) => l.status === filter.status);
  }
  if (filter?.minScore != null) {
    list = list.filter((l) => l.score >= filter.minScore!);
  }
  return list.sort((a, b) => b.date - a.date);
}

export function createMockApi(): Api {
  const api: Api = {
    settings: {
      async get() {
        await delay(80);
        return { ...settings };
      },
      async set(patch) {
        await delay(100);
        settings = { ...settings, ...patch };
        return { ...settings };
      },
    },
    accounts: {
      async list() {
        await delay(60);
        return accounts.map((a) => ({ ...a }));
      },
      async startLogin(phone) {
        await delay(400);
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
        await delay(500);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        if (code.length < 4) return { accountId, status: 'wait_code', error: 'Неверный код' };
        acc.status = 'authorized';
        acc.tgUserId = nid();
        acc.firstName = 'Новый';
        acc.username = 'new_user';
        emit({ type: 'account:update', account: { ...acc } });
        return { accountId, status: 'authorized' };
      },
      async submitPassword(accountId, password) {
        await delay(400);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        if (!password) return { accountId, status: 'wait_password', error: 'Нужен пароль 2FA' };
        acc.status = 'authorized';
        emit({ type: 'account:update', account: { ...acc } });
        return { accountId, status: 'authorized' };
      },
      async update(accountId, patch) {
        await delay(80);
        const acc = accounts.find((a) => a.id === accountId);
        if (!acc) throw new Error('Аккаунт не найден');
        Object.assign(acc, patch);
        if (patch.isPrimary) accounts.forEach((a) => { if (a.id !== accountId) a.isPrimary = false; });
        emit({ type: 'account:update', account: { ...acc } });
        return { ...acc };
      },
      async remove(accountId) {
        await delay(100);
        const i = accounts.findIndex((a) => a.id === accountId);
        if (i >= 0) accounts.splice(i, 1);
      },
    },
    projects: {
      async list() {
        await delay(80);
        return projects.map((p) => ({ ...p, autopilot: { ...p.autopilot } }));
      },
      async create(input) {
        await delay(200);
        const p: Project = {
          id: nid(),
          ...input,
          autopilot: makeAutopilot(),
          createdAt: Date.now(),
        };
        projects.push(p);
        emit({ type: 'project:update', project: { ...p } });
        return { ...p };
      },
      async update(id, patch) {
        await delay(150);
        const p = projects.find((x) => x.id === id);
        if (!p) throw new Error('Проект не найден');
        Object.assign(p, patch);
        emit({ type: 'project:update', project: { ...p, autopilot: { ...p.autopilot } } });
        return { ...p, autopilot: { ...p.autopilot } };
      },
      async remove(id) {
        await delay(100);
        const i = projects.findIndex((x) => x.id === id);
        if (i >= 0) projects.splice(i, 1);
      },
      async suggestKeywords(input) {
        await delay(1200);
        const base = ['telegram бот', 'разработка заказ', 'mvp стартап', 'typescript разработчик', 'автоматизация'];
        if (input.target.toLowerCase().includes('маркет')) return ['маркетолог', 'таргет', 'лидогенерация'];
        return base;
      },
    },
    sources: {
      async importCsv() {
        await delay(300);
        return { added: 0, skipped: 0, failed: [] };
      },
      async list(projectId) {
        await delay(60);
        return sources.filter((s) => s.projectId === projectId).map((s) => ({ ...s }));
      },
      async discover(projectId) {
        emit({ type: 'job', projectId, stage: 'Поиск в Telegram…', done: false });
        await delay(2000);
        const p = projects.find((x) => x.id === projectId);
        const newSrc: Source = {
          id: nid(),
          projectId,
          tgChatId: nid(),
          title: `Найдено: ${p?.keywords[0] ?? 'чат'}`,
          username: 'found_chat',
          kind: 'supergroup',
          memberCount: 1500,
          status: 'candidate',
          foundBy: p?.keywords[0] ?? 'search',
          accountId: 1,
          checkedLeads: 0,
          matchedLeads: 0,
          lastScannedAt: null,
          lastMessageId: null,
          createdAt: Date.now(),
        };
        sources.push(newSrc);
        emit({ type: 'source:update', source: { ...newSrc } });
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
        return sources.filter((s) => s.projectId === projectId).map((s) => ({ ...s }));
      },
      async scan(projectId, sourceIds) {
        emit({ type: 'job', projectId, stage: 'Сканирование сообщений…', done: false });
        await delay(2500);
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
        const checked = sourceIds?.length ?? sources.filter((s) => s.projectId === projectId).length;
        return { checked, newLeads: 1 };
      },
      async add(projectId, linkOrUsername) {
        await delay(300);
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
      async setStatus(sourceId, status) {
        await delay(80);
        const s = sources.find((x) => x.id === sourceId);
        if (!s) throw new Error('Источник не найден');
        s.status = status;
        emit({ type: 'source:update', source: { ...s } });
        return { ...s };
      },
    },
    leads: {
      async setHandoff(leadId, handoff) {
        const l = leads.find((x) => x.id === leadId)!;
        Object.assign(l, { handoff, handoffReason: handoff ? 'Взято вручную' : null });
        return { ...l };
      },
      async list(projectId, filter) {
        await delay(50);
        return filterLeads(projectId, filter);
      },
      async feedback(leadId, value) {
        await delay(60);
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        l.feedback = value;
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...l };
      },
      async setStatus(leadId, status) {
        await delay(60);
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        l.status = status;
        emit({ type: 'lead:update', lead: { ...l } });
        return { ...l };
      },
    },
    messages: {
      async list(leadId) {
        await delay(40);
        return messages.filter((m) => m.leadId === leadId).map((m) => ({ ...m }));
      },
      async draft(leadId) {
        await delay(900);
        const l = leads.find((x) => x.id === leadId);
        return `Здравствуйте${l?.authorName ? `, ${l.authorName.split(' ')[0]}` : ''}! Увидел ваш запрос — могу помочь с разработкой. Когда удобно обсудить детали?`;
      },
      async send(leadId, text, where) {
        await delay(300);
        const l = leads.find((x) => x.id === leadId);
        if (!l) throw new Error('Лид не найден');
        const acc = accounts.find((a) => a.id === (l.accountId ?? 1)) ?? accounts[0];
        if (acc.sentToday >= acc.dailyLimit) {
          throw new Error(`Дневной лимит аккаунта исчерпан (${acc.dailyLimit})`);
        }
        acc.sentToday += 1;
        const msg: ChatMessage = {
          id: nid(),
          leadId,
          accountId: acc.id,
          direction: 'out',
          where,
          kind: 'text',
          mediaPath: null,
          durationSec: null,
          text,
          tgChatId: l.tgChatId,
          tgMessageId: nid(),
          date: Date.now(),
          auto: false,
        };
        messages.push(msg);
        if (l.status === 'new') l.status = 'replied';
        emit({ type: 'message:new', message: { ...msg } });
        emit({ type: 'lead:update', lead: { ...l } });
        emit({ type: 'account:update', account: { ...acc } });
        return { ...msg };
      },
    },
    autopilot: {
      async set(projectId, patch) {
        await delay(80);
        const p = projects.find((x) => x.id === projectId);
        if (!p) throw new Error('Проект не найден');
        p.autopilot = { ...p.autopilot, ...patch };
        if (patch.enabled && !p.autopilot.nextRunAt) {
          p.autopilot.nextRunAt = Date.now() + p.autopilot.scanIntervalMin * 60_000;
        }
        emit({ type: 'project:update', project: { ...p, autopilot: { ...p.autopilot } } });
        return { ...p, autopilot: { ...p.autopilot } };
      },
      async runNow(projectId) {
        emit({ type: 'job', projectId, stage: 'Автопилот…', done: false });
        await delay(3000);
        const p = projects.find((x) => x.id === projectId);
        if (p) {
          p.autopilot.lastRunAt = Date.now();
          p.autopilot.nextRunAt = Date.now() + p.autopilot.scanIntervalMin * 60_000;
          emit({ type: 'project:update', project: { ...p, autopilot: { ...p.autopilot } } });
        }
        emit({ type: 'job', projectId, stage: 'Готово', done: true });
      },
    },
    crm: {
      async get(leadId) {
        return mockCard(leadId);
      },
      async update(leadId, patch) {
        return { ...mockCard(leadId), ...patch };
      },
      async refresh(leadId) {
        await delay(500);
        return mockCard(leadId);
      },
      async generateBrief(leadId) {
        await delay(800);
        return mockCard(leadId);
      },
      async addNote(leadId, text) {
        return { id: nid(), leadId, accountId: null, direction: 'out', where: 'dm', kind: 'note', text, mediaPath: null, durationSec: null, tgChatId: 0, tgMessageId: null, date: Date.now(), auto: false };
      },
      async board() {
        return leads.slice(0, 6).map((lead) => ({ lead: { ...lead }, card: mockCard(lead.id) }));
      },
    },
    voice: {
      async send() {
        throw new Error('Голосовые в демо-режиме не отправляются');
      },
      async preview() {
        throw new Error('Озвучка в демо-режиме недоступна');
      },
    },
    calls: {
      async save() {
        throw new Error('Запись созвонов в демо-режиме недоступна');
      },
    },
    manager: {
      async test() {
        await delay(400);
        return { reply: 'Понял задачу. Подскажите сроки и бюджет — и предложу варианты.', handoff: false, reason: '' };
      },
    },
    broadcasts: {
      async list() {
        return [];
      },
      async create() {
        throw new Error('Рассылки в демо-режиме не создаются');
      },
      async update() {
        throw new Error('Рассылки в демо-режиме не изменяются');
      },
      async remove() {},
      async runNow() {
        return { posted: 0, skipped: 0, errors: 0 };
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

  // Simulate new lead every 20s
  setInterval(() => {
    const p = projects[0];
    const src = sources.find((s) => s.projectId === p.id);
    const lead: Lead = {
      id: nid(),
      projectId: p.id,
      sourceId: src?.id ?? null,
      tgChatId: src?.tgChatId ?? 101,
      tgMessageId: nid(),
      authorUserId: nid(),
      authorName: 'Новый лид',
      authorUsername: 'fresh_lead',
      text: 'Срочно нужен разработчик для интеграции CRM и Telegram — откликнитесь в личку.',
      date: Date.now(),
      link: 'https://t.me/example/1',
      score: 89,
      label: 'demand',
      reason: 'Свежий запрос на интеграцию.',
      ...leadExtra,
      feedback: null,
      status: 'new',
      accountId: null,
      createdAt: Date.now(),
    };
    leads.unshift(lead);
    emit({ type: 'lead:new', lead: { ...lead } });
  }, 20_000);

  return api;
}

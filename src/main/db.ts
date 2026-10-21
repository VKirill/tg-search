// SQLite storage (node:sqlite, built into Electron's Node). One file in userData.
// Arrays and nested objects are stored as JSON text.

import { DatabaseSync } from 'node:sqlite';
import { VOICE_TRANSCRIPT_FAILED } from './voice/incoming';
import {
  DEFAULT_AUTOPILOT,
  DEFAULT_MANAGER,
  type Account,
  type ManagerSettings,
  type Anamnesis,
  type Broadcast,
  type Category,
  type Order,
  type Service,
  type ServiceKind,
  type UsageKind,
  type BroadcastChat,
  type ClientCard,
  type AutopilotSettings,
  type ChatMessage,
  type Lead,
  type LeadFilter,
  type LeadStatus,
  type Project,
  type ProjectInput,
  type Settings,
  type Source,
  type SourceStatus,
} from '../shared/types';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  tg_user_id INTEGER, username TEXT, first_name TEXT, last_name TEXT, photo_path TEXT,
  status TEXT NOT NULL DEFAULT 'logged_out',
  daily_limit INTEGER NOT NULL DEFAULT 10,
  pause_sec INTEGER NOT NULL DEFAULT 180,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_day TEXT, last_sent_at INTEGER,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, task TEXT NOT NULL, target TEXT NOT NULL, offer TEXT NOT NULL DEFAULT '',
  geo TEXT NOT NULL DEFAULT '[]', languages TEXT NOT NULL DEFAULT '[]',
  account_ids TEXT NOT NULL DEFAULT '[]', materials TEXT NOT NULL DEFAULT '[]',
  keywords TEXT NOT NULL DEFAULT '[]', autopilot TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tg_chat_id INTEGER NOT NULL, title TEXT NOT NULL, username TEXT, kind TEXT NOT NULL,
  member_count INTEGER, status TEXT NOT NULL DEFAULT 'candidate', found_by TEXT,
  account_id INTEGER, checked_leads INTEGER NOT NULL DEFAULT 0, matched_leads INTEGER NOT NULL DEFAULT 0,
  last_scanned_at INTEGER, last_message_id INTEGER, created_at INTEGER NOT NULL,
  UNIQUE(project_id, tg_chat_id)
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
  tg_chat_id INTEGER NOT NULL, tg_message_id INTEGER NOT NULL,
  author_user_id INTEGER, author_name TEXT, author_username TEXT,
  text TEXT NOT NULL, date INTEGER NOT NULL, link TEXT,
  score INTEGER NOT NULL, label TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
  feedback TEXT, status TEXT NOT NULL DEFAULT 'new', account_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(project_id, tg_chat_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS leads_author ON leads(author_user_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  account_id INTEGER, direction TEXT NOT NULL, "where" TEXT NOT NULL, text TEXT NOT NULL,
  tg_chat_id INTEGER NOT NULL, tg_message_id INTEGER, date INTEGER NOT NULL, auto INTEGER NOT NULL DEFAULT 0
);
-- Every message already evaluated per project, so rescans never pay the LLM twice.
CREATE TABLE IF NOT EXISTS cards (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'new', summary TEXT NOT NULL DEFAULT '', anamnesis TEXT NOT NULL DEFAULT '{}',
  brief TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', completeness INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, brief_updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS broadcasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, text TEXT NOT NULL, account_ids TEXT NOT NULL DEFAULT '[]', chats TEXT NOT NULL DEFAULT '[]',
  interval_hours REAL NOT NULL DEFAULT 24, spin INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
);
-- Every analyzed message once (globally, not per project): the demand map behind statistics.
CREATE TABLE IF NOT EXISTS classified (
  tg_chat_id INTEGER NOT NULL, tg_message_id INTEGER NOT NULL, day TEXT NOT NULL, date INTEGER NOT NULL,
  category_id INTEGER, category_prob REAL NOT NULL, request_prob REAL NOT NULL, text TEXT NOT NULL, link TEXT,
  PRIMARY KEY(tg_chat_id, tg_message_id)
);
CREATE INDEX IF NOT EXISTS classified_day ON classified(day);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL, kind TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, units REAL NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, name TEXT NOT NULL, category_id INTEGER, enabled INTEGER NOT NULL DEFAULT 1,
  price_min INTEGER NOT NULL, price_max INTEGER NOT NULL, instructions TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
  preview_enabled INTEGER NOT NULL DEFAULT 0, revisions INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  service_id INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'collecting', price INTEGER, brief TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]', payment_id TEXT, payment_url TEXT, paid_at INTEGER, result TEXT,
  revisions_used INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS orders_lead ON orders(lead_id);
CREATE TABLE IF NOT EXISTS seen (
  project_id INTEGER NOT NULL, tg_chat_id INTEGER NOT NULL, tg_message_id INTEGER NOT NULL,
  PRIMARY KEY(project_id, tg_chat_id, tg_message_id)
);
`;

type Row = Record<string, any>;

const json = (v: unknown) => JSON.stringify(v);
const parse = <T>(s: string | null, fallback: T): T => (s ? (JSON.parse(s) as T) : fallback);

function toAccount(r: Row): Account {
  return {
    id: r.id, phone: r.phone, tgUserId: r.tg_user_id, username: r.username, firstName: r.first_name,
    lastName: r.last_name, photoPath: r.photo_path, status: r.status, dailyLimit: r.daily_limit,
    pauseSec: r.pause_sec, sentToday: r.sent_today, sentDay: r.sent_day, lastSentAt: r.last_sent_at,
    isPrimary: !!r.is_primary,
  };
}

function toProject(r: Row): Project {
  return {
    id: r.id, name: r.name, task: r.task, target: r.target, offer: r.offer, criteria: r.criteria,
    geo: parse(r.geo, []), languages: parse(r.languages, []), accountIds: parse(r.account_ids, []),
    materials: parse(r.materials, []), keywords: parse(r.keywords, []), sequence: parse(r.sequence, []),
    manager: { ...DEFAULT_MANAGER, ...parse<Partial<ManagerSettings>>(r.manager, {}) },
    agent: r.agent ?? '',
    autopilot: { ...DEFAULT_AUTOPILOT, ...parse<Partial<AutopilotSettings>>(r.autopilot, {}) },
    createdAt: r.created_at,
  };
}

function toBroadcast(r: Row): Broadcast {
  return {
    id: r.id, name: r.name, text: r.text, accountIds: parse(r.account_ids, []), chats: parse(r.chats, []),
    intervalHours: r.interval_hours, spin: !!r.spin, enabled: !!r.enabled, createdAt: r.created_at,
  };
}

function toSource(r: Row): Source {
  return {
    id: r.id, projectId: r.project_id, tgChatId: r.tg_chat_id, title: r.title, username: r.username,
    kind: r.kind, memberCount: r.member_count, status: r.status, foundBy: r.found_by, accountId: r.account_id,
    checkedLeads: r.checked_leads, matchedLeads: r.matched_leads, lastScannedAt: r.last_scanned_at,
    lastMessageId: r.last_message_id, createdAt: r.created_at,
  };
}

function toLead(r: Row): Lead {
  return {
    id: r.id, projectId: r.project_id, sourceId: r.source_id, tgChatId: r.tg_chat_id, tgMessageId: r.tg_message_id,
    authorUserId: r.author_user_id, authorName: r.author_name, authorUsername: r.author_username, text: r.text,
    date: r.date, link: r.link, score: r.score, label: r.label, reason: r.reason, feedback: r.feedback,
    status: r.status, accountId: r.account_id, clientId: r.client_id ?? null, repeatCount: r.repeat_count ?? 0,
    spamTemplateId: r.spam_template_id ?? null, categoryId: r.category_id ?? null, sequenceStep: r.sequence_step, nextStepAt: r.next_step_at,
    handoff: !!r.handoff, handoffReason: r.handoff_reason, createdAt: r.created_at,
  };
}

export const EMPTY_ANAMNESIS: Anamnesis = {
  task: '', goal: '', audience: '', features: [], integrations: [], stack: [], deadline: '', budget: '',
  references: [], contacts: '', openQuestions: [],
};

function toCard(r: Row): ClientCard {
  return {
    leadId: r.lead_id, stage: r.stage, summary: r.summary,
    anamnesis: { ...EMPTY_ANAMNESIS, ...parse<Partial<Anamnesis>>(r.anamnesis, {}) },
    brief: r.brief, notes: r.notes, completeness: r.completeness, updatedAt: r.updated_at, briefUpdatedAt: r.brief_updated_at,
  };
}

function toMessage(r: Row): ChatMessage {
  return {
    id: r.id, leadId: r.lead_id, accountId: r.account_id, direction: r.direction, where: r.where, kind: r.kind,
    mediaPath: r.media_path, durationSec: r.duration_sec, text: r.text,
    tgChatId: r.tg_chat_id, tgMessageId: r.tg_message_id, date: r.date, auto: !!r.auto,
  };
}

export const SETTINGS_DEFAULTS: Settings = {
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmApiKey: '',
  llmModel: 'anthropic/claude-haiku-5.5',
  jevBaseUrl: 'https://api.openlux.ai/v1',
  jevApiKey: '',
  jevModel: 'jev-1.14.0',
  handoffNotifyTo: '',
  ownerName: 'Кирилл',
  sttBaseUrl: 'https://api.groq.com/openai/v1', // Groq Whisper: fast and cheap; any OpenAI-compatible endpoint works
  sttApiKey: '',
  sttModel: 'whisper-large-v3-turbo',
  ttsBaseUrl: 'https://api.openai.com/v1',
  ttsApiKey: '',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'nova',
  jevPricePerMTok: '0.042',
  sttPricePerMin: '0.00067', // Groq whisper-large-v3-turbo: $0.04 per hour
  ttsPricePerMin: '0.015',
  imagePricePerImage: '0.04',
  requestThreshold: '0.2',
  yookassaShopId: '',
  yookassaSecretKey: '',
  yookassaReturnUrl: 'https://t.me',
  auxBaseUrl: '', // any OpenAI-compatible endpoint (e.g. a 9router instance); set in Settings
  auxApiKey: '',
  auxModel: 'ag/gemini-3.8-flash',
  falKey: '',
  imageModel: 'fal-ai/nano-banana-2/edit',
  newsInterests:
    'ИИ в маркетинге и рекламе, новые нейросети и ИИ-инструменты, обновления Telegram, Яндекс Директа и маркетплейсов, ' +
    'кейсы с цифрами',
  operatorProvider: 'glm',
  glmApiKey: '',
  deepseekApiKey: '',
  operatorBaseUrl: '',
  operatorApiKey: '',
  operatorModel: '',
  tavilyApiKey: '',
};

// Starter services; price ranges from Russian freelance market data (Kwork, student exchanges), 2026-10
const DEFAULT_SERVICES: { kind: ServiceKind; name: string; category: string; min: number; max: number; preview: boolean; instructions: string }[] = [
  {
    kind: 'homework', name: 'Домашнее задание по фото', category: 'Учёба и домашние задания', min: 300, max: 1500, preview: false,
    instructions:
      'Решаем школьные и студенческие задачи по фото: математика, физика, химия, информатика, языки. Попросить фото задания целиком, ' +
      'класс или курс и срок. Цена: 300–500 ₽ за простое школьное задание, до 1500 ₽ за вузовский уровень или много задач. ' +
      'Решение — пошагово с объяснением, ответ выделен, самопроверка перед отправкой. Если фото нечитаемо — попросить переснять.',
  },
  {
    kind: 'marketplace_card', name: 'Карточка товара для маркетплейса', category: 'Карточки маркетплейсов', min: 500, max: 3000, preview: true,
    instructions:
      'Карточки для Wildberries, Ozon, Яндекс Маркета: SEO-название, описание, характеристики, ключевые слова, инфографика 1–5 слайдов. ' +
      'Спросить: маркетплейс, товар и его фото, преимущества, ссылки на конкурентов. Цена: 500 ₽ текст или 1–2 слайда, до 3000 ₽ за полный комплект. ' +
      'Правила WB: на изображениях нельзя цены, скидки, QR-коды, телефоны и призывы к покупке. Превью — один слайд инфографики.',
  },
  {
    kind: 'image_gen', name: 'Нейрофото и генерация изображений', category: 'Фото и видео', min: 500, max: 2500, preview: true,
    instructions:
      'Нейрофотосессии, обработка и генерация изображений по фото клиента или описанию: портреты, аватарки, обложки, фото для соцсетей. ' +
      'Спросить: 1–3 чётких фото лица (для нейрофото), стиль, количество образов. Цена: 500 ₽ за 1–3 изображения, до 2500 ₽ за 10 образов. ' +
      'Фото клиента (в том числе аватар) использовать только после его явного согласия. Превью — одно изображение.',
  },
  {
    kind: 'copywriting', name: 'Тексты и контент-план', category: 'Тексты и копирайтинг', min: 300, max: 3000, preview: true,
    instructions:
      'Посты, описания, продающие тексты, контент-план на неделю или месяц. Брифа обычно нет: опереться на нишу, ссылки на аккаунт и конкурентов, ' +
      'додумать аудиторию и цели, явно назвать допущения. Цена: 300 ₽ за короткий текст, 1000–3000 ₽ за контент-план на неделю с примерами постов. ' +
      'Превью — 2–3 пункта плана или первый пост; к контент-плану можно предложить обложки.',
  },
];

const DEFAULT_CATEGORIES: [string, string][] = [
  ['Сайты и лендинги', 'Сайты, лендинги, интернет-магазины, вёрстка, Тильда, WordPress, доработка и поддержка сайтов'],
  ['Яндекс Директ и контекст', 'Настройка и ведение Яндекс Директа, Google Ads, контекстная реклама'],
  ['Фото и видео', 'Нейрофото, генерация и обработка фото, видеомонтаж, рилсы'],
  ['Telegram-боты и автоматизация', 'Telegram-боты, мини-приложения, приложения, автоматизация процессов, интеграции, ИИ-ассистенты'],
  ['Таргет и SMM', 'Таргет ВК и Telegram Ads, ведение соцсетей, SMM, посевы, продвижение Telegram-каналов'],
  ['SEO-продвижение', 'SEO сайта, вывод в топ, аудит, семантика, ссылки'],
  ['Дизайн', 'Логотипы, фирменный стиль, баннеры, обложки, презентации, дизайн сайтов и интерфейсов'],
  ['Учёба и домашние задания', 'Помощь с домашним заданием, контрольные, курсовые, решение задач, репетиторство'],
  ['Карточки маркетплейсов', 'Карточки товаров для Wildberries, Ozon, Яндекс Маркета: тексты, фото, инфографика, SEO'],
  ['Тексты и копирайтинг', 'Статьи, посты, продающие тексты, переводы, редактура'],
];

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.raw.exec(SCHEMA);
    this.seedCategories();
    // Columns added after the first release
    const projectCols = this.all('PRAGMA table_info(projects)').map((c) => c.name);
    if (!projectCols.includes('criteria')) this.raw.exec("ALTER TABLE projects ADD COLUMN criteria TEXT NOT NULL DEFAULT ''");
    if (!projectCols.includes('sequence')) this.raw.exec("ALTER TABLE projects ADD COLUMN sequence TEXT NOT NULL DEFAULT '[]'");
    if (!projectCols.includes('manager')) this.raw.exec("ALTER TABLE projects ADD COLUMN manager TEXT NOT NULL DEFAULT '{}'");
    if (!projectCols.includes('agent')) this.raw.exec("ALTER TABLE projects ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    const serviceCols = this.all('PRAGMA table_info(services)').map((c) => c.name);
    if (!serviceCols.includes('agent')) this.raw.exec("ALTER TABLE services ADD COLUMN agent TEXT NOT NULL DEFAULT ''");
    const messageCols = this.all('PRAGMA table_info(messages)').map((c) => c.name);
    if (!messageCols.includes('kind')) {
      this.raw.exec(`ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
        ALTER TABLE messages ADD COLUMN media_path TEXT;
        ALTER TABLE messages ADD COLUMN duration_sec REAL;`);
    }
    const leadCols = this.all('PRAGMA table_info(leads)').map((c) => c.name);
    if (!leadCols.includes('client_id')) this.raw.exec('ALTER TABLE leads ADD COLUMN client_id INTEGER');
    if (!leadCols.includes('category_id')) {
      this.raw.exec(`ALTER TABLE leads ADD COLUMN category_id INTEGER;
        UPDATE leads SET category_id = (SELECT c.category_id FROM classified c
          WHERE c.tg_chat_id = leads.tg_chat_id AND c.tg_message_id = leads.tg_message_id);`);
    }
    if (!leadCols.includes('repeat_count')) {
      this.raw.exec(`ALTER TABLE leads ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE leads ADD COLUMN spam_template_id INTEGER;`);
    }
    if (!leadCols.includes('sequence_step')) {
      this.raw.exec(`ALTER TABLE leads ADD COLUMN sequence_step INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE leads ADD COLUMN next_step_at INTEGER;
        ALTER TABLE leads ADD COLUMN handoff INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE leads ADD COLUMN handoff_reason TEXT;`);
    }
  }

  private seedCategories() {
    if (!this.one('SELECT 1 FROM categories LIMIT 1')) {
      for (const [name, description] of DEFAULT_CATEGORIES) this.run('INSERT INTO categories(name, description) VALUES(?, ?)', name, description);
    }
    if (!this.one('SELECT 1 FROM services LIMIT 1')) {
      const cats = new Map(this.listCategories().map((c) => [c.name, c.id]));
      for (const d of DEFAULT_SERVICES) {
        this.run(
          'INSERT INTO services(kind, name, category_id, price_min, price_max, instructions, preview_enabled) VALUES(?, ?, ?, ?, ?, ?, ?)',
          d.kind, d.name, cats.get(d.category) ?? null, d.min, d.max, d.instructions, Number(d.preview),
        );
      }
    }
  }

  private one(sql: string, ...args: any[]): Row | undefined {
    return this.raw.prepare(sql).get(...args) as Row | undefined;
  }
  private all(sql: string, ...args: any[]): Row[] {
    return this.raw.prepare(sql).all(...args) as Row[];
  }
  private run(sql: string, ...args: any[]) {
    return this.raw.prepare(sql).run(...args);
  }

  // Settings: stored values override defaults; env provides defaults for development.
  getSettings(): Settings {
    const stored = Object.fromEntries(this.all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
    return { ...SETTINGS_DEFAULTS, ...stored } as Settings;
  }
  setSettings(patch: Partial<Settings>): Settings {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      this.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
    }
    return this.getSettings();
  }

  // Accounts
  listAccounts(): Account[] {
    return this.all('SELECT * FROM accounts ORDER BY is_primary DESC, id').map(toAccount);
  }
  getAccount(id: number): Account {
    const r = this.one('SELECT * FROM accounts WHERE id = ?', id);
    if (!r) throw new Error(`account ${id} not found`);
    return toAccount(r);
  }
  upsertAccountByPhone(phone: string): Account {
    this.run('INSERT INTO accounts(phone) VALUES(?) ON CONFLICT(phone) DO NOTHING', phone);
    return toAccount(this.one('SELECT * FROM accounts WHERE phone = ?', phone)!);
  }
  updateAccount(id: number, patch: Partial<Account>): Account {
    const cols: Record<string, string> = {
      tgUserId: 'tg_user_id', username: 'username', firstName: 'first_name', lastName: 'last_name',
      photoPath: 'photo_path', status: 'status', dailyLimit: 'daily_limit', pauseSec: 'pause_sec',
      sentToday: 'sent_today', sentDay: 'sent_day', lastSentAt: 'last_sent_at', isPrimary: 'is_primary',
    };
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col || v === undefined) continue;
      this.run(`UPDATE accounts SET ${col} = ? WHERE id = ?`, typeof v === 'boolean' ? Number(v) : v, id);
    }
    return this.getAccount(id);
  }
  removeAccount(id: number) {
    this.run('DELETE FROM accounts WHERE id = ?', id);
  }

  // Projects
  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY id').map(toProject);
  }
  getProject(id: number): Project {
    const r = this.one('SELECT * FROM projects WHERE id = ?', id);
    if (!r) throw new Error(`project ${id} not found`);
    return toProject(r);
  }
  createProject(p: ProjectInput): Project {
    const res = this.run(
      `INSERT INTO projects(name, task, target, offer, criteria, geo, languages, account_ids, materials, keywords, sequence, manager, agent, autopilot, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name, p.task, p.target, p.offer, p.criteria ?? '', json(p.geo), json(p.languages), json(p.accountIds), json(p.materials),
      json(p.keywords), json(p.sequence ?? []), json({ ...DEFAULT_MANAGER, ...p.manager }), p.agent ?? '', json(DEFAULT_AUTOPILOT), Date.now(),
    );
    return this.getProject(Number(res.lastInsertRowid));
  }
  updateProject(id: number, patch: Partial<ProjectInput> & { autopilot?: Partial<AutopilotSettings> }): Project {
    const cur = this.getProject(id);
    const next = { ...cur, ...patch, autopilot: { ...cur.autopilot, ...patch.autopilot } };
    this.run(
      `UPDATE projects SET name = ?, task = ?, target = ?, offer = ?, criteria = ?, geo = ?, languages = ?, account_ids = ?,
       materials = ?, keywords = ?, sequence = ?, manager = ?, agent = ?, autopilot = ? WHERE id = ?`,
      next.name, next.task, next.target, next.offer, next.criteria, json(next.geo), json(next.languages), json(next.accountIds),
      json(next.materials), json(next.keywords), json(next.sequence), json(next.manager), next.agent ?? '', json(next.autopilot), id,
    );
    return this.getProject(id);
  }
  removeProject(id: number) {
    this.run('DELETE FROM projects WHERE id = ?', id);
  }

  // Sources
  listSources(projectId: number): Source[] {
    return this.all('SELECT * FROM sources WHERE project_id = ? ORDER BY status, matched_leads DESC, id', projectId).map(toSource);
  }
  getSource(id: number): Source {
    const r = this.one('SELECT * FROM sources WHERE id = ?', id);
    if (!r) throw new Error(`source ${id} not found`);
    return toSource(r);
  }
  listAllSources(): Source[] {
    return this.all('SELECT * FROM sources ORDER BY id').map(toSource);
  }
  findSourcesByChat(tgChatId: number): Source[] {
    return this.all('SELECT * FROM sources WHERE tg_chat_id = ?', tgChatId).map(toSource);
  }
  findSource(projectId: number, tgChatId: number): Source | undefined {
    const r = this.one('SELECT * FROM sources WHERE project_id = ? AND tg_chat_id = ?', projectId, tgChatId);
    return r && toSource(r);
  }
  addSource(s: Pick<Source, 'projectId' | 'tgChatId' | 'title' | 'username' | 'kind' | 'memberCount' | 'foundBy' | 'accountId'> & { status?: SourceStatus }): Source {
    this.run(
      `INSERT INTO sources(project_id, tg_chat_id, title, username, kind, member_count, status, found_by, account_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, tg_chat_id) DO NOTHING`,
      s.projectId, s.tgChatId, s.title, s.username, s.kind, s.memberCount, s.status ?? 'candidate', s.foundBy, s.accountId, Date.now(),
    );
    return this.findSource(s.projectId, s.tgChatId)!;
  }
  updateSource(id: number, patch: Partial<Pick<Source, 'status' | 'accountId' | 'lastScannedAt' | 'lastMessageId' | 'title' | 'memberCount'>>): Source {
    const cols: Record<string, string> = {
      status: 'status', accountId: 'account_id', lastScannedAt: 'last_scanned_at', lastMessageId: 'last_message_id',
      title: 'title', memberCount: 'member_count',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (cols[k] && v !== undefined) this.run(`UPDATE sources SET ${cols[k]} = ? WHERE id = ?`, v, id);
    }
    return this.getSource(id);
  }
  bumpSourceStats(id: number, checked: number, matched: number) {
    this.run('UPDATE sources SET checked_leads = checked_leads + ?, matched_leads = matched_leads + ? WHERE id = ?', checked, matched, id);
  }

  // Seen messages
  filterUnseen<T extends { chatId: number; messageId: number }>(projectId: number, msgs: T[]): T[] {
    const stmt = this.raw.prepare('SELECT 1 FROM seen WHERE project_id = ? AND tg_chat_id = ? AND tg_message_id = ?');
    return msgs.filter((m) => !stmt.get(projectId, m.chatId, m.messageId));
  }
  markSeen(projectId: number, msgs: { chatId: number; messageId: number }[]) {
    const stmt = this.raw.prepare('INSERT OR IGNORE INTO seen(project_id, tg_chat_id, tg_message_id) VALUES(?, ?, ?)');
    for (const m of msgs) stmt.run(projectId, m.chatId, m.messageId);
  }

  // Leads
  listLeads(projectId: number, f: LeadFilter = {}): Lead[] {
    const where = ['project_id = ?'];
    const args: any[] = [projectId];
    if (f.status && f.status !== 'all') { where.push('status = ?'); args.push(f.status); }
    else if (!f.status) where.push("status != 'hidden'");
    if (f.minScore !== undefined) { where.push('score >= ?'); args.push(f.minScore); }
    if (f.search) { where.push('(text LIKE ? OR author_name LIKE ? OR author_username LIKE ?)'); const q = `%${f.search}%`; args.push(q, q, q); }
    return this.all(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY date DESC LIMIT 500`, ...args).map(toLead);
  }
  getLead(id: number): Lead {
    const r = this.one('SELECT * FROM leads WHERE id = ?', id);
    if (!r) throw new Error(`lead ${id} not found`);
    return toLead(r);
  }
  // Returns the new lead, or undefined when this message is already a lead of the project.
  addLead(l: Omit<Lead, 'id' | 'createdAt' | 'feedback' | 'status' | 'accountId' | 'clientId' | 'repeatCount' | 'spamTemplateId' | 'categoryId' | 'sequenceStep' | 'nextStepAt' | 'handoff' | 'handoffReason'>): Lead | undefined {
    const res = this.run(
      `INSERT INTO leads(project_id, source_id, tg_chat_id, tg_message_id, author_user_id, author_name, author_username,
       text, date, link, score, label, reason, created_at, category_id)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT category_id FROM classified WHERE tg_chat_id = ? AND tg_message_id = ?)) ON CONFLICT DO NOTHING`,
      l.projectId, l.sourceId, l.tgChatId, l.tgMessageId, l.authorUserId, l.authorName, l.authorUsername,
      l.text, l.date, l.link, l.score, l.label, l.reason, Date.now(), l.tgChatId, l.tgMessageId,
    );
    return res.changes ? this.getLead(Number(res.lastInsertRowid)) : undefined;
  }
  updateLead(
    id: number,
    patch: Partial<Pick<Lead, 'feedback' | 'status' | 'accountId' | 'sequenceStep' | 'nextStepAt' | 'handoff' | 'handoffReason'>>,
  ): Lead {
    const cols: Record<string, string> = {
      feedback: 'feedback', status: 'status', accountId: 'account_id', sequenceStep: 'sequence_step',
      nextStepAt: 'next_step_at', handoff: 'handoff', handoffReason: 'handoff_reason',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (cols[k] && v !== undefined) this.run(`UPDATE leads SET ${cols[k]} = ? WHERE id = ?`, typeof v === 'boolean' ? Number(v) : v, id);
    }
    return this.getLead(id);
  }
  setLeadStatus(id: number, status: LeadStatus): Lead {
    return this.updateLead(id, { status });
  }
  // Leads this user wrote to us about (private dialogs are matched by author).
  findLeadsByAuthor(authorUserId: number): Lead[] {
    return this.all('SELECT * FROM leads WHERE author_user_id = ? ORDER BY id DESC', authorUserId).map(toLead);
  }
  feedbackExamples(projectId: number, limit = 20): { text: string; verdict: 'up' | 'down' }[] {
    return this.all(
      'SELECT text, feedback FROM leads WHERE project_id = ? AND feedback IS NOT NULL ORDER BY id DESC LIMIT ?',
      projectId, limit,
    ).map((r) => ({ text: r.text, verdict: r.feedback }));
  }

  // Dialog messages
  // Leads whose latest message is from the client and newer than sinceMs
  leadsAwaitingReply(sinceMs: number): number[] {
    return this.all(
      `SELECT m.lead_id FROM messages m WHERE m.id = (SELECT id FROM messages WHERE lead_id = m.lead_id ORDER BY date DESC, id DESC LIMIT 1)
         AND m.direction = 'in' AND m.date >= ?`,
      sinceMs,
    ).map((r) => r.lead_id as number);
  }
  listMessages(leadId: number): ChatMessage[] {
    return this.all('SELECT * FROM messages WHERE lead_id = ? ORDER BY date, id', leadId).map(toMessage);
  }
  // kind/mediaPath/durationSec default to a plain text message
  addMessage(m: Omit<ChatMessage, 'id' | 'kind' | 'mediaPath' | 'durationSec'> & Partial<Pick<ChatMessage, 'kind' | 'mediaPath' | 'durationSec'>>): ChatMessage {
    const res = this.run(
      `INSERT INTO messages(lead_id, account_id, direction, "where", kind, text, media_path, duration_sec, tg_chat_id, tg_message_id, date, auto)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.leadId, m.accountId, m.direction, m.where, m.kind ?? 'text', m.text, m.mediaPath ?? null, m.durationSec ?? null,
      m.tgChatId, m.tgMessageId, m.date, Number(m.auto),
    );
    return toMessage(this.one('SELECT * FROM messages WHERE id = ?', Number(res.lastInsertRowid))!);
  }

  // Broadcasts
  listBroadcasts(): Broadcast[] {
    return this.all('SELECT * FROM broadcasts ORDER BY id').map(toBroadcast);
  }
  getBroadcast(id: number): Broadcast {
    const r = this.one('SELECT * FROM broadcasts WHERE id = ?', id);
    if (!r) throw new Error(`broadcast ${id} not found`);
    return toBroadcast(r);
  }
  createBroadcast(b: Pick<Broadcast, 'name' | 'text' | 'accountIds' | 'chats' | 'intervalHours' | 'spin'>): Broadcast {
    const res = this.run(
      `INSERT INTO broadcasts(name, text, account_ids, chats, interval_hours, spin, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.text, json(b.accountIds), json(b.chats), b.intervalHours, Number(b.spin), Date.now(),
    );
    return this.getBroadcast(Number(res.lastInsertRowid));
  }
  updateBroadcast(id: number, patch: Partial<Omit<Broadcast, 'id' | 'createdAt'>>): Broadcast {
    const next = { ...this.getBroadcast(id), ...patch };
    this.run(
      `UPDATE broadcasts SET name = ?, text = ?, account_ids = ?, chats = ?, interval_hours = ?, spin = ?, enabled = ? WHERE id = ?`,
      next.name, next.text, json(next.accountIds), json(next.chats), next.intervalHours, Number(next.spin), Number(next.enabled), id,
    );
    return this.getBroadcast(id);
  }
  updateBroadcastChat(id: number, tgChatId: number, patch: Partial<BroadcastChat>): Broadcast {
    const b = this.getBroadcast(id);
    return this.updateBroadcast(id, { chats: b.chats.map((c) => (c.tgChatId === tgChatId ? { ...c, ...patch } : c)) });
  }
  removeBroadcast(id: number) {
    this.run('DELETE FROM broadcasts WHERE id = ?', id);
  }

  failedVoiceMessages(sinceMs: number): ChatMessage[] {
    return this.all(
      `SELECT * FROM messages WHERE kind = 'voice' AND direction = 'in' AND media_path IS NOT NULL AND date >= ? AND text = ?`,
      sinceMs, VOICE_TRANSCRIPT_FAILED,
    ).map(toMessage);
  }
  updateMessageText(id: number, text: string) {
    this.run('UPDATE messages SET text = ? WHERE id = ?', text, id);
  }

  // CRM cards: one per lead, created on first access
  getCard(leadId: number): ClientCard {
    this.run('INSERT INTO cards(lead_id, updated_at) VALUES(?, ?) ON CONFLICT(lead_id) DO NOTHING', leadId, Date.now());
    return toCard(this.one('SELECT * FROM cards WHERE lead_id = ?', leadId)!);
  }
  updateCard(leadId: number, patch: Partial<Omit<ClientCard, 'leadId' | 'updatedAt'>>): ClientCard {
    const next = { ...this.getCard(leadId), ...patch };
    this.run(
      `UPDATE cards SET stage = ?, summary = ?, anamnesis = ?, brief = ?, notes = ?, completeness = ?, updated_at = ?,
       brief_updated_at = ? WHERE lead_id = ?`,
      next.stage, next.summary, json(next.anamnesis), next.brief, next.notes, next.completeness, Date.now(),
      next.briefUpdatedAt, leadId,
    );
    return this.getCard(leadId);
  }
  // Leads that have a card or a dialog, newest activity first (pipeline view)
  listCardLeads(projectId?: number): Lead[] {
    const where = projectId ? 'AND l.project_id = ?' : '';
    const args = projectId ? [projectId] : [];
    return this.all(
      `SELECT l.* FROM leads l LEFT JOIN cards c ON c.lead_id = l.id
       WHERE (c.lead_id IS NOT NULL OR l.status IN ('replied', 'dialog')) ${where}
       ORDER BY COALESCE(c.updated_at, l.created_at) DESC LIMIT 500`,
      ...args,
    ).map(toLead);
  }

  // Demand categories
  listCategories(): Category[] {
    return this.all('SELECT * FROM categories ORDER BY id').map((r) => ({ id: r.id, name: r.name, description: r.description, enabled: !!r.enabled }));
  }
  getCategory(id: number): Category {
    const c = this.listCategories().find((x) => x.id === id);
    if (!c) throw new Error(`category ${id} not found`);
    return c;
  }
  createCategory(name: string, description: string): Category {
    const res = this.run('INSERT INTO categories(name, description) VALUES(?, ?)', name, description);
    return this.getCategory(Number(res.lastInsertRowid));
  }
  updateCategory(id: number, patch: Partial<Omit<Category, 'id'>>): Category {
    const next = { ...this.getCategory(id), ...patch };
    this.run('UPDATE categories SET name = ?, description = ?, enabled = ? WHERE id = ?', next.name, next.description, Number(next.enabled), id);
    return this.getCategory(id);
  }
  removeCategory(id: number) {
    this.run('DELETE FROM categories WHERE id = ?', id);
    this.run('UPDATE classified SET category_id = NULL WHERE category_id = ?', id);
    this.run('UPDATE leads SET category_id = NULL WHERE category_id = ?', id);
  }

  // Classified messages (global, once per message)
  leadsWithoutCategory(): Lead[] {
    return this.all('SELECT * FROM leads WHERE category_id IS NULL ORDER BY id DESC LIMIT 500').map(toLead);
  }
  syncLeadCategory(leadId: number): Lead {
    this.run(
      `UPDATE leads SET category_id = (SELECT c.category_id FROM classified c
        WHERE c.tg_chat_id = leads.tg_chat_id AND c.tg_message_id = leads.tg_message_id) WHERE id = ?`,
      leadId,
    );
    return this.getLead(leadId);
  }
  filterUnclassified<T extends { chatId: number; messageId: number }>(msgs: T[]): T[] {
    const stmt = this.raw.prepare('SELECT 1 FROM classified WHERE tg_chat_id = ? AND tg_message_id = ?');
    return msgs.filter((m) => !stmt.get(m.chatId, m.messageId));
  }
  // Request probability per message key; messages never classified are absent
  requestProbs(msgs: { chatId: number; messageId: number }[]): Map<string, number> {
    const stmt = this.raw.prepare('SELECT request_prob FROM classified WHERE tg_chat_id = ? AND tg_message_id = ?');
    const out = new Map<string, number>();
    for (const m of msgs) {
      const r = stmt.get(m.chatId, m.messageId) as Row | undefined;
      if (r) out.set(`${m.chatId}:${m.messageId}`, r.request_prob);
    }
    return out;
  }
  addClassified(c: { chatId: number; messageId: number; day: string; date: number; categoryId: number | null; categoryProb: number; requestProb: number; text: string; link: string | null }) {
    this.run(
      `INSERT OR IGNORE INTO classified(tg_chat_id, tg_message_id, day, date, category_id, category_prob, request_prob, text, link)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.chatId, c.messageId, c.day, c.date, c.categoryId, c.categoryProb, c.requestProb, c.text.slice(0, 2000), c.link,
    );
  }

  // AI usage and spend
  addUsage(u: { day: string; kind: UsageKind; model: string; inputTokens: number; outputTokens: number; units: number; costUsd: number }) {
    this.run(
      'INSERT INTO usage(day, kind, model, input_tokens, output_tokens, units, cost_usd) VALUES(?, ?, ?, ?, ?, ?, ?)',
      u.day, u.kind, u.model, u.inputTokens, u.outputTokens, u.units, u.costUsd,
    );
  }

  // Raw aggregates for the statistics report over [fromDay, toDay] (local YYYY-MM-DD)
  statsRows(fromDay: string, toDay: string, threshold: number, fromMs: number, toMs: number) {
    return {
      analyzed: this.all(
        `SELECT day, COUNT(*) n, SUM(request_prob >= ?) req FROM classified WHERE day BETWEEN ? AND ? GROUP BY day`,
        threshold, fromDay, toDay,
      ),
      usageByDay: this.all(
        `SELECT day, kind, SUM(cost_usd) cost FROM usage WHERE day BETWEEN ? AND ? GROUP BY day, kind`, fromDay, toDay,
      ),
      usage: this.all(
        `SELECT kind, model, COUNT(*) calls, SUM(input_tokens) input, SUM(output_tokens) output, SUM(units) units, SUM(cost_usd) cost
         FROM usage WHERE day BETWEEN ? AND ? GROUP BY kind, model ORDER BY cost DESC`, fromDay, toDay,
      ),
      leads: this.all('SELECT created_at ts FROM leads WHERE created_at BETWEEN ? AND ?', fromMs, toMs),
      sent: this.all("SELECT date ts FROM messages WHERE direction = 'out' AND kind != 'note' AND date BETWEEN ? AND ?", fromMs, toMs),
      categories: this.all(
        `SELECT category_id, COUNT(*) n, SUM(request_prob >= ?) req FROM classified WHERE day BETWEEN ? AND ?
         GROUP BY category_id ORDER BY req DESC, n DESC`, threshold, fromDay, toDay,
      ),
      examples: this.all(
        `SELECT category_id, text, link, date, request_prob FROM classified
         WHERE day BETWEEN ? AND ? AND request_prob >= ? ORDER BY request_prob DESC, date DESC LIMIT 400`,
        fromDay, toDay, threshold,
      ),
    };
  }

  // Services («Исполнители»)
  listServices(): Service[] {
    return this.all('SELECT * FROM services ORDER BY id').map(toService);
  }
  getService(id: number): Service {
    const r = this.one('SELECT * FROM services WHERE id = ?', id);
    if (!r) throw new Error(`service ${id} not found`);
    return toService(r);
  }
  createService(v: Omit<Service, 'id'>): Service {
    const res = this.run(
      `INSERT INTO services(kind, name, category_id, enabled, price_min, price_max, instructions, model, preview_enabled, revisions, agent)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      v.kind, v.name, v.categoryId, Number(v.enabled), v.priceMin, v.priceMax, v.instructions, v.model, Number(v.previewEnabled), v.revisions, v.agent ?? '',
    );
    return this.getService(Number(res.lastInsertRowid));
  }
  updateService(id: number, patch: Partial<Omit<Service, 'id'>>): Service {
    const v = { ...this.getService(id), ...patch };
    this.run(
      `UPDATE services SET kind = ?, name = ?, category_id = ?, enabled = ?, price_min = ?, price_max = ?, instructions = ?, model = ?,
       preview_enabled = ?, revisions = ?, agent = ? WHERE id = ?`,
      v.kind, v.name, v.categoryId, Number(v.enabled), v.priceMin, v.priceMax, v.instructions, v.model, Number(v.previewEnabled), v.revisions, v.agent ?? '', id,
    );
    return this.getService(id);
  }
  removeService(id: number) {
    this.run('DELETE FROM services WHERE id = ?', id);
  }

  // Orders
  listOrders(leadId?: number): Order[] {
    return (leadId ? this.all('SELECT * FROM orders WHERE lead_id = ? ORDER BY id DESC', leadId) : this.all('SELECT * FROM orders ORDER BY id DESC LIMIT 500')).map(toOrder);
  }
  getOrder(id: number): Order {
    const r = this.one('SELECT * FROM orders WHERE id = ?', id);
    if (!r) throw new Error(`order ${id} not found`);
    return toOrder(r);
  }
  createOrder(leadId: number, serviceId: number, brief: string): Order {
    const now = Date.now();
    const res = this.run('INSERT INTO orders(lead_id, service_id, brief, created_at, updated_at) VALUES(?, ?, ?, ?, ?)', leadId, serviceId, brief, now, now);
    return this.getOrder(Number(res.lastInsertRowid));
  }
  updateOrder(id: number, patch: Partial<Omit<Order, 'id' | 'leadId' | 'createdAt' | 'updatedAt'>>): Order {
    const o = { ...this.getOrder(id), ...patch };
    this.run(
      `UPDATE orders SET service_id = ?, status = ?, price = ?, brief = ?, files = ?, payment_id = ?, payment_url = ?, paid_at = ?,
       result = ?, revisions_used = ?, error = ?, updated_at = ? WHERE id = ?`,
      o.serviceId, o.status, o.price, o.brief, json(o.files), o.paymentId, o.paymentUrl, o.paidAt, o.result, o.revisionsUsed, o.error, Date.now(), id,
    );
    return this.getOrder(id);
  }
}

function toService(r: Row): Service {
  return {
    id: r.id, kind: r.kind, name: r.name, categoryId: r.category_id, enabled: !!r.enabled, priceMin: r.price_min, priceMax: r.price_max,
    instructions: r.instructions, model: r.model, previewEnabled: !!r.preview_enabled, revisions: r.revisions, agent: r.agent ?? '',
  };
}

function toOrder(r: Row): Order {
  return {
    id: r.id, leadId: r.lead_id, serviceId: r.service_id, status: r.status, price: r.price, brief: r.brief, files: parse(r.files, []),
    paymentId: r.payment_id, paymentUrl: r.payment_url, paidAt: r.paid_at, result: r.result, revisionsUsed: r.revisions_used,
    error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

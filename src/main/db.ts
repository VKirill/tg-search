// SQLite storage (node:sqlite, built into Electron's Node). One file in userData.
// Arrays and nested objects are stored as JSON text.

import { DatabaseSync } from 'node:sqlite';
import {
  DEFAULT_AUTOPILOT,
  type Account,
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
    id: r.id, name: r.name, task: r.task, target: r.target, offer: r.offer,
    geo: parse(r.geo, []), languages: parse(r.languages, []), accountIds: parse(r.account_ids, []),
    materials: parse(r.materials, []), keywords: parse(r.keywords, []),
    autopilot: { ...DEFAULT_AUTOPILOT, ...parse<Partial<AutopilotSettings>>(r.autopilot, {}) },
    createdAt: r.created_at,
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
    status: r.status, accountId: r.account_id, createdAt: r.created_at,
  };
}

function toMessage(r: Row): ChatMessage {
  return {
    id: r.id, leadId: r.lead_id, accountId: r.account_id, direction: r.direction, where: r.where, text: r.text,
    tgChatId: r.tg_chat_id, tgMessageId: r.tg_message_id, date: r.date, auto: !!r.auto,
  };
}

export const SETTINGS_DEFAULTS: Settings = {
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmApiKey: '',
  llmModel: 'anthropic/claude-haiku-5.5',
};

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.raw.exec(SCHEMA);
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
      `INSERT INTO projects(name, task, target, offer, geo, languages, account_ids, materials, keywords, autopilot, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.name, p.task, p.target, p.offer, json(p.geo), json(p.languages), json(p.accountIds), json(p.materials),
      json(p.keywords), json(DEFAULT_AUTOPILOT), Date.now(),
    );
    return this.getProject(Number(res.lastInsertRowid));
  }
  updateProject(id: number, patch: Partial<ProjectInput> & { autopilot?: Partial<AutopilotSettings> }): Project {
    const cur = this.getProject(id);
    const next = { ...cur, ...patch, autopilot: { ...cur.autopilot, ...patch.autopilot } };
    this.run(
      `UPDATE projects SET name = ?, task = ?, target = ?, offer = ?, geo = ?, languages = ?, account_ids = ?,
       materials = ?, keywords = ?, autopilot = ? WHERE id = ?`,
      next.name, next.task, next.target, next.offer, json(next.geo), json(next.languages), json(next.accountIds),
      json(next.materials), json(next.keywords), json(next.autopilot), id,
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
  addLead(l: Omit<Lead, 'id' | 'createdAt' | 'feedback' | 'status' | 'accountId'>): Lead | undefined {
    const res = this.run(
      `INSERT INTO leads(project_id, source_id, tg_chat_id, tg_message_id, author_user_id, author_name, author_username,
       text, date, link, score, label, reason, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      l.projectId, l.sourceId, l.tgChatId, l.tgMessageId, l.authorUserId, l.authorName, l.authorUsername,
      l.text, l.date, l.link, l.score, l.label, l.reason, Date.now(),
    );
    return res.changes ? this.getLead(Number(res.lastInsertRowid)) : undefined;
  }
  updateLead(id: number, patch: Partial<Pick<Lead, 'feedback' | 'status' | 'accountId'>>): Lead {
    const cols: Record<string, string> = { feedback: 'feedback', status: 'status', accountId: 'account_id' };
    for (const [k, v] of Object.entries(patch)) {
      if (cols[k] && v !== undefined) this.run(`UPDATE leads SET ${cols[k]} = ? WHERE id = ?`, v, id);
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
  listMessages(leadId: number): ChatMessage[] {
    return this.all('SELECT * FROM messages WHERE lead_id = ? ORDER BY date, id', leadId).map(toMessage);
  }
  addMessage(m: Omit<ChatMessage, 'id'>): ChatMessage {
    const res = this.run(
      `INSERT INTO messages(lead_id, account_id, direction, "where", text, tg_chat_id, tg_message_id, date, auto)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.leadId, m.accountId, m.direction, m.where, m.text, m.tgChatId, m.tgMessageId, m.date, Number(m.auto),
    );
    return toMessage(this.one('SELECT * FROM messages WHERE id = ?', Number(res.lastInsertRowid))!);
  }
}

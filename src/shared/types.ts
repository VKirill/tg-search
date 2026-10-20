// Domain types and the IPC contract shared by main, preload and renderer.
// Changing anything here is a contract change: record it in docs/decisions.md.

export type ProjectTask = 'clients' | 'partners' | 'investors' | 'jobs' | 'ads';

export interface Material {
  kind: 'file' | 'url';
  value: string; // file path or URL
  text?: string; // extracted text used as AI context
}

export interface AutopilotSettings {
  enabled: boolean;
  refreshSources: boolean; // find new sources and replace weak ones
  scanIntervalMin: number; // how often to check sources for new messages
  freshnessHours: number; // ignore messages older than this
  workingListSize: number; // max active sources per project
  aiReply: boolean; // send AI replies automatically from project accounts
  replyTarget: 'dm' | 'chat';
  replyInNewSources: boolean;
  joinIfNeeded: boolean; // join a chat when reading or replying requires it
  minScore: number; // auto-reply only to leads with score >= minScore
  lastRunAt: number | null; // unix ms
  nextRunAt: number | null; // unix ms
}

export interface Project {
  id: number;
  name: string;
  task: ProjectTask;
  target: string; // who or what to find
  offer: string; // what matters: your experience, offer, conditions
  geo: string[];
  languages: string[];
  accountIds: number[];
  materials: Material[];
  keywords: string[];
  autopilot: AutopilotSettings;
  createdAt: number;
}

export type ProjectInput = Pick<
  Project,
  'name' | 'task' | 'target' | 'offer' | 'geo' | 'languages' | 'accountIds' | 'materials' | 'keywords'
>;

export type AccountStatus = 'authorized' | 'wait_code' | 'wait_password' | 'logged_out' | 'error';

export interface Account {
  id: number;
  phone: string;
  tgUserId: number | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  photoPath: string | null;
  status: AccountStatus;
  dailyLimit: number; // outgoing messages per day
  pauseSec: number; // min pause between outgoing messages
  sentToday: number;
  sentDay: string | null; // YYYY-MM-DD of sentToday
  lastSentAt: number | null; // unix ms
  isPrimary: boolean;
}

export type ChatKind = 'group' | 'supergroup' | 'channel' | 'private';

export type SourceStatus = 'candidate' | 'active' | 'rejected';

export interface Source {
  id: number;
  projectId: number;
  tgChatId: number;
  title: string;
  username: string | null;
  kind: ChatKind;
  memberCount: number | null;
  status: SourceStatus;
  foundBy: string | null; // keyword that found it, or 'manual'
  accountId: number | null; // account that reads it
  checkedLeads: number; // leads evaluated from this source
  matchedLeads: number; // of them scored as relevant
  lastScannedAt: number | null;
  lastMessageId: number | null;
  createdAt: number;
}

export type LeadLabel = 'demand' | 'interest' | 'irrelevant';
export type LeadStatus = 'new' | 'replied' | 'dialog' | 'hidden';

export interface Lead {
  id: number;
  projectId: number;
  sourceId: number | null;
  tgChatId: number;
  tgMessageId: number;
  authorUserId: number | null; // null when the contact is unknown (channel post)
  authorName: string | null;
  authorUsername: string | null;
  text: string;
  date: number; // unix ms of the original message
  link: string | null; // t.me link to the original message
  score: number; // 0..100
  label: LeadLabel;
  reason: string;
  feedback: 'up' | 'down' | null;
  status: LeadStatus;
  accountId: number | null; // account that talks to this lead
  createdAt: number;
}

export interface ChatMessage {
  id: number;
  leadId: number;
  accountId: number | null;
  direction: 'in' | 'out';
  where: 'dm' | 'chat';
  text: string;
  tgChatId: number;
  tgMessageId: number | null;
  date: number; // unix ms
  auto: boolean; // sent by autopilot
}

export interface Settings {
  tgApiId: string;
  tgApiHash: string;
  llmBaseUrl: string; // OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1
  llmApiKey: string;
  llmModel: string;
}

export interface LeadFilter {
  status?: LeadStatus | 'all';
  minScore?: number;
  search?: string;
}

export interface LoginState {
  accountId: number;
  status: AccountStatus;
  error?: string;
}

export type AppEvent =
  | { type: 'lead:new'; lead: Lead }
  | { type: 'lead:update'; lead: Lead }
  | { type: 'message:new'; message: ChatMessage }
  | { type: 'account:update'; account: Account }
  | { type: 'source:update'; source: Source }
  | { type: 'project:update'; project: Project }
  | { type: 'job'; projectId: number; stage: string; done: boolean; error?: string };

// The API exposed to the renderer as window.api (see src/preload/index.ts).
export interface Api {
  settings: {
    get(): Promise<Settings>;
    set(patch: Partial<Settings>): Promise<Settings>;
  };
  accounts: {
    list(): Promise<Account[]>;
    startLogin(phone: string): Promise<LoginState>;
    submitCode(accountId: number, code: string): Promise<LoginState>;
    submitPassword(accountId: number, password: string): Promise<LoginState>;
    update(accountId: number, patch: Partial<Pick<Account, 'dailyLimit' | 'pauseSec' | 'isPrimary'>>): Promise<Account>;
    remove(accountId: number): Promise<void>;
  };
  projects: {
    list(): Promise<Project[]>;
    create(input: ProjectInput): Promise<Project>;
    update(id: number, patch: Partial<ProjectInput>): Promise<Project>;
    remove(id: number): Promise<void>;
    suggestKeywords(input: Pick<ProjectInput, 'task' | 'target' | 'offer' | 'geo' | 'languages' | 'materials'>): Promise<string[]>;
  };
  sources: {
    list(projectId: number): Promise<Source[]>;
    discover(projectId: number): Promise<Source[]>; // search Telegram by project keywords
    scan(projectId: number, sourceIds?: number[]): Promise<{ checked: number; newLeads: number }>;
    add(projectId: number, linkOrUsername: string): Promise<Source>;
    setStatus(sourceId: number, status: SourceStatus): Promise<Source>;
  };
  leads: {
    list(projectId: number, filter?: LeadFilter): Promise<Lead[]>;
    feedback(leadId: number, value: 'up' | 'down' | null): Promise<Lead>;
    setStatus(leadId: number, status: LeadStatus): Promise<Lead>;
  };
  messages: {
    list(leadId: number): Promise<ChatMessage[]>;
    draft(leadId: number): Promise<string>;
    send(leadId: number, text: string, where: 'dm' | 'chat'): Promise<ChatMessage>;
  };
  autopilot: {
    set(projectId: number, patch: Partial<AutopilotSettings>): Promise<Project>;
    runNow(projectId: number): Promise<void>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  onEvent(cb: (e: AppEvent) => void): () => void;
}

export const DEFAULT_AUTOPILOT: AutopilotSettings = {
  enabled: false,
  refreshSources: false,
  scanIntervalMin: 60,
  freshnessHours: 24,
  workingListSize: 10,
  aiReply: false,
  replyTarget: 'dm',
  replyInNewSources: false,
  joinIfNeeded: false,
  minScore: 80,
  lastRunAt: null,
  nextRunAt: null,
};

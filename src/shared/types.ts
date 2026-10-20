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

// One step of the outreach chain. Step 0 is the first message; later steps go out only while the lead stays silent.
export interface SequenceStep {
  delayHours: number; // after the previous step (ignored for step 0)
  mode: 'template' | 'ai'; // template: send text as is; ai: text is an instruction for the AI writer
  text: string; // template supports {name} and {request}
}

// AI manager that talks to a lead after they answer, like a sales manager, until it hands the dialog to a human.
export interface ManagerSettings {
  enabled: boolean;
  baseUrl: string; // any OpenAI-compatible endpoint; empty = global LLM settings
  apiKey: string; // empty = global LLM key
  model: string; // empty = global LLM model
  prompt: string; // persona, goal, offer details, prices, rules, when to hand over
  replyDelaySec: number; // wait before answering: looks human and merges message bursts
  maxReplies: number; // auto replies per lead, then hand over to a human
  voiceReplies: 'never' | 'mirror'; // mirror: answer with a voice note when the client sent a voice note
}

export interface ManagerTestResult {
  reply: string;
  handoff: boolean; // the manager wants a human to take over
  reason: string;
}

export interface Project {
  id: number;
  name: string;
  task: ProjectTask;
  target: string; // who or what to find
  offer: string; // what matters: your experience, offer, conditions
  criteria: string; // project prompt: what kind of message fits and may get an automatic offer (used by Jev)
  geo: string[];
  languages: string[];
  accountIds: number[];
  materials: Material[];
  keywords: string[];
  sequence: SequenceStep[];
  manager: ManagerSettings;
  autopilot: AutopilotSettings;
  createdAt: number;
}

export type ProjectInput = Pick<
  Project,
  'name' | 'task' | 'target' | 'offer' | 'criteria' | 'geo' | 'languages' | 'accountIds' | 'materials' | 'keywords' | 'sequence' | 'manager'
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
  sequenceStep: number; // index of the next chain step to send (0 = nothing sent yet)
  nextStepAt: number | null; // unix ms when the next chain step is due; null = chain finished or stopped
  handoff: boolean; // a human handles this dialog: the AI manager stays silent
  handoffReason: string | null;
  createdAt: number;
}

export type MessageKind = 'text' | 'voice' | 'call' | 'note';

export interface ChatMessage {
  id: number;
  leadId: number;
  accountId: number | null;
  direction: 'in' | 'out';
  where: 'dm' | 'chat';
  kind: MessageKind; // voice: Telegram voice note; call: recorded call; note: owner's private note (never sent)
  text: string; // for voice/call: the transcript
  mediaPath: string | null; // local audio file for voice/call
  durationSec: number | null;
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
  jevBaseUrl: string; // TypeSafe System One endpoint base, e.g. https://api.openlux.ai/v1
  jevApiKey: string; // empty = qualify with the LLM instead of Jev
  jevModel: string; // e.g. jev-1.14.0
  handoffNotifyTo: string; // @username that gets a summary when the AI manager hands a dialog over; empty = app notification only
  ownerName: string; // whose assistant the AI manager is, e.g. «Кирилл»
  sttBaseUrl: string; // OpenAI-compatible /audio/transcriptions, e.g. https://api.openai.com/v1
  sttApiKey: string;
  sttModel: string; // e.g. gpt-4o-transcribe
  ttsBaseUrl: string; // OpenAI-compatible /audio/speech
  ttsApiKey: string;
  ttsModel: string; // e.g. gpt-4o-mini-tts
  ttsVoice: string; // e.g. nova
}

// Mini-CRM card of one client dialog (lead): stage, running summary, anamnesis and the brief (ТЗ) for the owner.
export type DealStage = 'new' | 'contacted' | 'discovery' | 'brief_ready' | 'handed_over' | 'proposal' | 'won' | 'lost';

export interface Anamnesis {
  task: string; // what the client wants in their words, condensed
  goal: string; // business goal / why
  audience: string;
  features: string[]; // required functionality
  integrations: string[]; // CRM, payments, APIs…
  stack: string[]; // suggested technologies (assistant's guess, owner decides)
  deadline: string;
  budget: string;
  references: string[]; // examples, links, competitors
  contacts: string; // phone/email/company if the client shared them
  openQuestions: string[]; // what is still unknown — the assistant asks these next
}

export interface ClientCard {
  leadId: number;
  stage: DealStage;
  summary: string; // where the conversation stopped, 3–6 lines, refreshed automatically
  anamnesis: Anamnesis;
  brief: string; // Markdown technical brief (ТЗ) for the owner to price the work
  notes: string; // owner's free notes
  completeness: number; // 0..100: how much of the anamnesis is known
  updatedAt: number;
  briefUpdatedAt: number | null;
}

// Periodic posting of an offer into chosen chats from the user's accounts.
export interface BroadcastChat {
  tgChatId: number;
  title: string;
  username: string | null;
  lastPostedAt: number | null; // unix ms
  lastError: string | null;
}

export interface Broadcast {
  id: number;
  name: string;
  text: string;
  accountIds: number[]; // accounts that post, in rotation
  chats: BroadcastChat[];
  intervalHours: number; // at most one post per chat per interval
  spin: boolean; // let the LLM vary the wording of every post (identical texts look like spam)
  enabled: boolean;
  createdAt: number;
}

export interface BroadcastInput {
  name: string;
  text: string;
  accountIds: number[];
  chatLinks: string[]; // @username or t.me links, resolved on save
  intervalHours: number;
  spin: boolean;
}

export interface ImportResult {
  added: number;
  skipped: number; // already in the project
  failed: { value: string; error: string }[];
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
  | { type: 'broadcast:update'; broadcast: Broadcast }
  | { type: 'crm:update'; card: ClientCard }
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
    // CSV with a chat link/username in the first column (header optional); joins chats in the background.
    importCsv(projectId: number, csv: string): Promise<ImportResult>;
    setStatus(sourceId: number, status: SourceStatus): Promise<Source>;
  };
  leads: {
    list(projectId: number, filter?: LeadFilter): Promise<Lead[]>;
    feedback(leadId: number, value: 'up' | 'down' | null): Promise<Lead>;
    setStatus(leadId: number, status: LeadStatus): Promise<Lead>;
    setHandoff(leadId: number, handoff: boolean): Promise<Lead>; // take the dialog over / give it back to the AI manager
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
  crm: {
    get(leadId: number): Promise<ClientCard>;
    update(leadId: number, patch: Partial<Pick<ClientCard, 'stage' | 'summary' | 'anamnesis' | 'brief' | 'notes'>>): Promise<ClientCard>;
    refresh(leadId: number): Promise<ClientCard>; // re-read the whole dialog (texts, voice and call transcripts) with the LLM
    generateBrief(leadId: number): Promise<ClientCard>; // write the ТЗ from the anamnesis and the dialog
    addNote(leadId: number, text: string): Promise<ChatMessage>; // private note in the timeline
    board(projectId?: number): Promise<{ lead: Lead; card: ClientCard }[]>; // all cards for a pipeline view
  };
  voice: {
    // TTS → Telegram voice note to the lead (dm or chat), through the limiter
    send(leadId: number, text: string, where: 'dm' | 'chat'): Promise<ChatMessage>;
    preview(text: string): Promise<string>; // synthesize only, returns a local file path to play
  };
  calls: {
    // Recording is captured in the renderer (mic + system audio); main stores, transcribes and updates the CRM card.
    save(leadId: number, audio: Uint8Array, mimeType: string, durationSec: number): Promise<ChatMessage>;
  };
  manager: {
    // Sandbox: one manager turn for a made-up dialog, without Telegram. history excludes the lead's first message.
    test(projectId: number, leadText: string, history: { direction: 'in' | 'out'; text: string }[], settings?: ManagerSettings): Promise<ManagerTestResult>;
  };
  broadcasts: {
    list(): Promise<Broadcast[]>;
    create(input: BroadcastInput): Promise<Broadcast>;
    update(id: number, patch: Partial<BroadcastInput> & { enabled?: boolean }): Promise<Broadcast>;
    remove(id: number): Promise<void>;
    runNow(id: number): Promise<{ posted: number; skipped: number; errors: number }>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
  };
  onEvent(cb: (e: AppEvent) => void): () => void;
}

export const DEFAULT_MANAGER: ManagerSettings = {
  enabled: false,
  baseUrl: '',
  apiKey: '',
  model: '',
  prompt:
    'Ты — помощник {owner}, собираешь заявку клиента. Представляйся как помощник {owner}. Пиши коротко и по-человечески, на языке собеседника, по одному вопросу за раз. ' +
    'Цель — собрать анамнез: что нужно сделать, зачем, для кого, какой функционал и интеграции, сроки, бюджет, примеры. Цены и сроки не называй — их назовёт {owner} после изучения задачи. ' +
    'Когда задача понятна или клиент просит цену, договор, созвон или живого человека — скажи, что передаёшь заявку {owner}, и он свяжется лично.',
  replyDelaySec: 60,
  maxReplies: 12,
  voiceReplies: 'never',
};

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

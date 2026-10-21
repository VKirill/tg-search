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

// What the manager wants to do with an order in this turn; code validates and applies it.
export interface ManagerOrderIntent {
  serviceId: number; // matching service from the catalog
  brief: string; // client's wishes + the agent's assumptions so far
  agreedPrice: number | null; // the price the client accepted (inside the service range)
  wantsPreview: boolean; // make and send a free sample now
  readyToPay: boolean; // client agreed: send the payment link
  photoConsent: boolean; // client explicitly allowed using their photo/avatar
}

export interface ManagerTestResult {
  reply: string;
  handoff: boolean; // the manager wants a human to take over
  reason: string;
  order?: ManagerOrderIntent | null;
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
  agent: string; // primary agent for this topic's client sessions ('' = 'manager')
  autopilot: AutopilotSettings;
  createdAt: number;
}

export type ProjectInput = Pick<
  Project,
  'name' | 'task' | 'target' | 'offer' | 'criteria' | 'geo' | 'languages' | 'accountIds' | 'materials' | 'keywords' | 'sequence' | 'manager'
> & { agent?: string };

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

export type SourceStatus = 'candidate' | 'active' | 'rejected' | 'spam'; // spam: the chat is in the spam-chat blocklist

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
  clientId: number | null; // long-term client (null until the author is known)
  repeatCount: number; // times the same author re-posted (near-)the same text after this lead; not new leads
  spamTemplateId: number | null; // the text matches a spam template (many authors, same text) — hidden from inboxes
  categoryId: number | null; // demand category of the message (Директ, сайты, дизайн…); null = not classified or none fits
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
  jevPricePerMTok: string; // USD per 1M input tokens (OpenLux jev-1.14: ~0.042); output is free
  sttPricePerMin: string; // USD per audio minute, estimate for statistics
  ttsPricePerMin: string; // USD per audio minute, estimate for statistics
  imagePricePerImage: string; // USD per generated image (fal.ai does not return the cost), estimate
  requestThreshold: string; // 0..1: messages below this «is a request» probability skip project qualification
  // Payments (ЮKassa; test shop until the owner connects the working one)
  yookassaShopId: string;
  yookassaSecretKey: string;
  yookassaReturnUrl: string; // where the client lands after paying, e.g. https://t.me/<account>
  // Auxiliary model for client dossiers (OpenAI-compatible; default 9router Gemini 3.8 Flash, needs stream:false)
  auxBaseUrl: string;
  auxApiKey: string;
  auxModel: string;
  // Image generation for executors and previews (fal.ai)
  falKey: string;
  imageModel: string; // fal model id for generation/editing
  // «Новости»: what the owner wants to keep a hand on the pulse of; Jev scores channel posts against it
  newsInterests: string;
  // Operator: the tool-calling agent that talks to clients. Provider switch keeps a key per provider so the owner can
  // compare GLM and DeepSeek without retyping; 'custom' uses operatorBaseUrl/operatorApiKey/operatorModel.
  operatorProvider: 'glm' | 'deepseek' | 'custom';
  glmApiKey: string; // Z.ai (GLM 5.3 Flash)
  deepseekApiKey: string; // DeepSeek V4.1 Flash
  operatorBaseUrl: string;
  operatorApiKey: string;
  operatorModel: string; // model override for any provider ('' = provider default)
  tavilyApiKey: string; // web search for the assistant
  geminiApiKey: string; // Google AI Studio: web search with Google grounding when Tavily is out of quota or unset
}

// Long-term client: one person across all leads, topics and accounts (docs/architecture-agent.md)
export interface Client {
  id: number;
  tgUserId: number | null;
  name: string;
  username: string | null;
  leadIds: number[];
  createdAt: number;
  lastSeenAt: number | null;
}

export type FactKind = 'profile' | 'preference' | 'deal' | 'material' | 'other';

export interface MemoryFact {
  id: number;
  clientId: number;
  kind: FactKind;
  text: string;
  source: string | null; // e.g. "message 1234", "order 12", "owner"
  active: boolean; // superseded facts stay for history
  createdAt: number;
}

export interface MemoryEpisode {
  id: number;
  clientId: number;
  fromMs: number;
  toMs: number;
  summary: string;
  messages: number;
}

export type AssetRole = 'from_client' | 'preview' | 'delivered' | 'working';

export interface Asset {
  id: number;
  clientId: number;
  orderId: number | null;
  path: string; // under userData
  mime: string;
  name: string;
  role: AssetRole;
  caption: string; // what is on it, for search and reuse months later
  tags: string[];
  createdAt: number;
}

// Subscriptions («личный ассистент») and the payments ledger
export interface Plan {
  id: number;
  name: string;
  priceMonth: number; // RUB
  description: string; // what the client gets; the agent sells from this text
  tasksPerMonth: number; // errands included per period
  enabled: boolean;
}

export type SubscriptionStatus = 'pending' | 'active' | 'past_due' | 'canceled';

export interface Subscription {
  id: number;
  clientId: number;
  planId: number;
  status: SubscriptionStatus;
  periodStart: number | null;
  periodEnd: number | null;
  tasksUsed: number;
  createdAt: number;
}

export interface Payment {
  id: number;
  clientId: number;
  purpose: 'order' | 'subscription';
  orderId: number | null;
  subscriptionId: number | null;
  amount: number; // RUB
  status: 'pending' | 'succeeded' | 'canceled';
  providerId: string | null; // ЮKassa payment id
  url: string | null;
  createdAt: number;
  paidAt: number | null;
}

// One action of the operator agent, shown to the owner under the dialog
export interface AgentStep {
  id: number;
  leadId: number;
  ts: number;
  tool: string;
  input: string; // JSON, truncated
  output: string; // truncated
  ok: boolean;
}

// «Исполнители»: services the AI manager sells and performs itself end to end.
export type ServiceKind = 'homework' | 'marketplace_card' | 'image_gen' | 'copywriting' | 'assistant' | 'agent'; // assistant: web research; agent: any task by an agent file (Service.agent)

export interface Service {
  id: number;
  kind: ServiceKind; // which built-in executor performs it
  name: string;
  categoryId: number | null; // demand category it answers
  enabled: boolean;
  priceMin: number; // RUB; the agent quotes inside [priceMin, priceMax] by complexity
  priceMax: number;
  instructions: string; // the skill: what we do, what to ask, how to price, quality bar, delivery format
  model: string; // LLM for this executor ('' = executor default)
  previewEnabled: boolean; // a free sample (covers, one image, plan outline) before payment to sell the order
  revisions: number; // free revisions after delivery
  agent: string; // for kind 'agent': the subagent file that performs it ('' otherwise)
}

// Agents in the opencode format (docs/architecture-agent.md): every client session runs under a primary agent;
// subagents perform delegated work. Files: userData/agents/<name>.md (front matter + system prompt body).
export type ToolPermission = 'allow' | 'ask' | 'deny'; // ask: the owner approves in «Согласования» before it runs

export interface AgentDef {
  name: string; // file name without .md
  description: string; // what it does and when to use it (the router and the primary agent read this)
  mode: 'primary' | 'subagent';
  model: string; // 'glm' | 'deepseek' | '<provider>/<model>' | '' (= operator provider switch)
  temperature: number | null;
  steps: number; // max tool iterations per turn; at the limit the agent summarizes what is left
  permission: Record<string, ToolPermission>; // tool name or glob ('*', 'order_*') → permission; last match wins
  prompt: string; // the body: role, how to talk, what to do and never do
  builtIn: boolean; // shipped default (editable; «Сбросить» restores it)
}

// Skills in the SKILL.md format (opencode / Claude Code compatible): loaded on demand with load_skill.
export interface SkillDef {
  name: string; // lowercase-hyphen, matches the folder
  description: string; // when to use it (shown to the agent and to the Jev router)
  body: string; // the instructions
  status: 'active' | 'draft' | 'disabled'; // drafts (learned from repeated tasks) wait for the owner's approval
  source: 'builtin' | 'owner' | 'learned';
  uses: number;
  lessons: string[]; // learned from finished orders (revisions, client feedback); appended when the skill is loaded
  updatedAt: number;
}

// Near-identical texts from many authors (bot campaigns, bait posts), learned automatically or marked by the owner.
export interface SpamTemplate {
  id: number;
  sample: string; // one original text
  authors: number; // distinct authors seen with this text
  messages: number;
  status: 'spam' | 'allowed'; // allowed: the owner said «не спам» — never auto-hidden again
  source: 'auto' | 'owner';
  createdAt: number;
  lastSeenAt: number;
}

// «Свои люди»: their tasks are free (training the agent on real work); optional daily message from the agent
export interface TrustedContact {
  username: string; // without @, lowercase
  userId: number | null; // learned on first contact
  free: boolean;
  dailyCheckin: boolean; // the agent writes first once a day to ask for tasks
  checkinHour: number; // local hour, 0..23
  lastCheckinAt: number | null;
  note: string;
}

// «Новости»: channels read without subscribing; their posts are scored by Jev against Settings.newsInterests
export interface NewsChannel {
  id: number;
  tgChatId: number;
  title: string;
  username: string | null;
  enabled: boolean;
  lastMessageId: number; // newest post already read
  lastCheckedAt: number | null;
  createdAt: number;
}

export type NewsStatus = 'new' | 'saved' | 'used' | 'dismissed';

export interface NewsItem {
  id: number;
  channelId: number;
  channelTitle: string;
  tgChatId: number;
  tgMessageId: number;
  text: string;
  link: string | null; // t.me link to the post
  date: number; // unix ms of the post
  score: number; // 0..100: worth a repost or a review for the owner's interests
  summary: string; // 1–2 sentences, Russian
  why: string; // why it is worth attention
  status: NewsStatus;
  createdAt: number;
}

// A chat with nothing but spam and repeats (or no live messages at all): left on every account, never joined again.
export interface SpamChat {
  tgChatId: number;
  title: string;
  username: string | null;
  reason: string; // «38 из 41 сообщения за неделю — спам и повторы» / «нет живых сообщений за неделю» / «отмечен вручную»
  messages: number; // messages seen in the window
  liveShare: number; // 0..1 share of live (non-spam, non-repeat) messages
  source: 'auto' | 'owner';
  createdAt: number;
}

export interface Approval {
  id: number;
  leadId: number;
  agent: string;
  tool: string;
  input: string; // JSON arguments
  summary: string; // human-readable: what the agent wants to do and why
  status: 'pending' | 'approved' | 'denied';
  createdAt: number;
  decidedAt: number | null;
}

export type OrderStatus =
  | 'collecting' // gathering wishes, inputs, assumptions
  | 'quoted' // price named, waiting for agreement
  | 'awaiting_payment'
  | 'paid'
  | 'in_progress'
  | 'delivered'
  | 'revision'
  | 'done'
  | 'cancelled'
  | 'failed';

export interface OrderFile {
  path: string; // local file
  role: 'input' | 'preview' | 'output';
  name: string;
  mime: string;
}

export interface Order {
  id: number;
  leadId: number;
  serviceId: number;
  status: OrderStatus;
  price: number | null; // RUB
  brief: string; // what the client wants + the agent's assumptions (clients rarely give a real brief)
  files: OrderFile[];
  paymentId: string | null;
  paymentUrl: string | null;
  paidAt: number | null;
  result: string | null; // text deliverable or a summary of delivered files
  revisionsUsed: number;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

// Demand map: every analyzed message gets one category and a «request vs chatter» probability.
export interface Category {
  id: number;
  name: string;
  description: string; // what requests belong here; shown to Jev
  enabled: boolean;
}

export type UsageKind = 'jev' | 'llm' | 'stt' | 'tts' | 'image';

export interface StatsDay {
  day: string; // YYYY-MM-DD, local
  analyzed: number; // messages classified
  requests: number; // request probability >= threshold
  chatter: number;
  leads: number;
  sent: number; // outgoing messages (manual, auto, broadcasts excluded)
  costUsd: number;
  costByKind: Record<UsageKind, number>;
}

export interface CategoryStat {
  categoryId: number | null; // null = no category fits
  name: string;
  messages: number;
  requests: number;
  examples: { text: string; link: string | null; date: number; prob: number }[]; // top requests by probability
}

export interface UsageStat {
  kind: UsageKind;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  units: number; // questions for jev, seconds for stt/tts, images for image
  costUsd: number;
}

export interface StatsReport {
  period: 'day' | 'week' | 'month';
  days: StatsDay[]; // oldest first, every day of the period
  totals: Omit<StatsDay, 'day'>;
  categories: CategoryStat[];
  usage: UsageStat[];
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
  | { type: 'news:new'; item: NewsItem }
  | { type: 'link:open'; url: string } // a Telegram link clicked anywhere: open it in «Чаты», not in the browser
  | { type: 'lead:new'; lead: Lead }
  | { type: 'lead:update'; lead: Lead }
  | { type: 'message:new'; message: ChatMessage }
  | { type: 'account:update'; account: Account }
  | { type: 'source:update'; source: Source }
  | { type: 'project:update'; project: Project }
  | { type: 'broadcast:update'; broadcast: Broadcast }
  | { type: 'crm:update'; card: ClientCard }
  | { type: 'order:update'; order: Order }
  | { type: 'memory:update'; clientId: number }
  | { type: 'billing:update'; clientId: number }
  | { type: 'agent:step'; step: AgentStep }
  | { type: 'approval:update'; approval: Approval }
  | { type: 'job'; projectId: number; stage: string; done: boolean; error?: string };

// The API exposed to the renderer as window.api (see src/preload/index.ts).
// «Чаты»: manual Telegram client over the work accounts — chat list, history, search, join/leave.
export interface ChatInfo {
  chatId: number;
  title: string;
  username: string | null;
  kind: ChatKind;
  memberCount: number | null;
  isMember: boolean;
  spamReason?: string | null; // in the spam-chat blocklist: why; such a chat cannot be joined
  linkedChatId?: number | null; // channel: its discussion group, joinable without subscribing to the channel
}

export interface ChatSummary extends ChatInfo {
  unreadCount: number;
  lastText: string | null;
  lastDate: number | null; // unix ms
}

export interface ChatItem {
  messageId: number;
  date: number; // unix ms
  text: string;
  senderName: string | null;
  senderUsername: string | null;
  isOutgoing: boolean;
  voice: { fileId: number; durationSec: number } | null;
  replyToMessageId: number | null;
  link: string | null;
}

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
  clients: {
    list(search?: string): Promise<Client[]>;
    get(clientId: number): Promise<Client>;
    byLead(leadId: number): Promise<Client | null>;
  };
  memory: {
    facts(clientId: number): Promise<MemoryFact[]>;
    addFact(clientId: number, kind: FactKind, text: string): Promise<MemoryFact>;
    removeFact(factId: number): Promise<void>; // marks inactive
    episodes(clientId: number): Promise<MemoryEpisode[]>;
    assets(clientId: number, query?: string): Promise<Asset[]>;
    sendAsset(leadId: number, assetId: number): Promise<void>; // re-send a stored file to the client
  };
  billing: {
    plans(): Promise<Plan[]>;
    savePlan(plan: Omit<Plan, 'id'> & { id?: number }): Promise<Plan>;
    removePlan(planId: number): Promise<void>;
    subscriptions(clientId?: number): Promise<Subscription[]>;
    subscribe(clientId: number, planId: number): Promise<Subscription>; // creates it and sends the first invoice
    cancelSubscription(subscriptionId: number): Promise<Subscription>;
    payments(clientId?: number): Promise<Payment[]>;
    checkPayment(paymentId: number): Promise<Payment>; // asks ЮKassa now
  };
  agent: {
    trace(leadId: number, limit?: number): Promise<AgentStep[]>;
  };
  agents: {
    list(): Promise<AgentDef[]>;
    save(def: AgentDef): Promise<AgentDef>;
    remove(name: string): Promise<void>; // built-ins are reset to default instead
    rules(): Promise<string>; // RULES.md: company rules every agent follows (AGENTS.md analog)
    saveRules(text: string): Promise<string>;
  };
  skills: {
    list(): Promise<SkillDef[]>;
    save(skill: Omit<SkillDef, 'uses' | 'updatedAt' | 'lessons'>): Promise<SkillDef>;
    remove(name: string): Promise<void>;
    approve(name: string): Promise<SkillDef>; // draft → active
    removeLesson(name: string, index: number): Promise<SkillDef>; // a wrong lesson
  };
  spam: {
    templates(): Promise<SpamTemplate[]>;
    markSpam(leadId: number): Promise<Lead>; // learn: this text (and look-alikes) is spam from now on
    setTemplateStatus(id: number, status: SpamTemplate['status']): Promise<SpamTemplate>; // «не спам» → allowed
    chats(): Promise<SpamChat[]>; // the spam-chat blocklist
    blockChat(accountId: number, chatId: number): Promise<SpamChat>; // owner: leave on every account and block
    unblockChat(tgChatId: number): Promise<void>; // joinable again; its sources go back to candidates
  };
  trusted: {
    list(): Promise<TrustedContact[]>;
    save(contact: Pick<TrustedContact, 'username'> & Partial<Pick<TrustedContact, 'free' | 'dailyCheckin' | 'checkinHour' | 'note'>>): Promise<TrustedContact>;
    remove(username: string): Promise<void>;
    checkinNow(): Promise<void>; // run the daily check-in now (for those not contacted today)
  };
  news: {
    channels(): Promise<NewsChannel[]>;
    addChannel(linkOrUsername: string): Promise<NewsChannel>; // @username or t.me link; no subscription
    updateChannel(id: number, patch: Partial<Pick<NewsChannel, 'enabled'>>): Promise<NewsChannel>;
    removeChannel(id: number): Promise<void>;
    items(status?: NewsStatus | 'all'): Promise<NewsItem[]>; // newest first; default: not dismissed
    setStatus(id: number, status: NewsStatus): Promise<NewsItem>;
    draft(id: number, kind: 'repost' | 'review'): Promise<string>; // a post for the owner's channel, Russian
    runNow(): Promise<number>; // read all channels now; returns how many posts were added
  };
  approvals: {
    list(status?: Approval['status']): Promise<Approval[]>;
    decide(id: number, approve: boolean): Promise<Approval>; // approved → the tool runs and the agent continues the dialog
  };
  services: {
    list(): Promise<Service[]>;
    create(input: Omit<Service, 'id'>): Promise<Service>;
    update(id: number, patch: Partial<Omit<Service, 'id'>>): Promise<Service>;
    remove(id: number): Promise<void>;
  };
  orders: {
    list(leadId?: number): Promise<Order[]>;
    create(leadId: number, serviceId: number, brief: string): Promise<Order>;
    update(id: number, patch: Partial<Pick<Order, 'brief' | 'price' | 'status'>>): Promise<Order>;
    requestPayment(id: number): Promise<Order>; // creates the ЮKassa payment and sends the link to the client
    markPaid(id: number): Promise<Order>; // manual confirmation
    run(id: number): Promise<Order>; // execute now (paid orders; owner may force)
    deliver(id: number): Promise<Order>; // send the result to the client
    cancel(id: number): Promise<Order>;
  };
  dossier: {
    path(leadId: number): Promise<string>; // the client's folder with profile, history and orders
    open(leadId: number): Promise<void>; // reveal it in Finder
  };
  stats: {
    report(period: 'day' | 'week' | 'month'): Promise<StatsReport>;
  };
  categories: {
    list(): Promise<Category[]>;
    create(input: Pick<Category, 'name' | 'description'>): Promise<Category>;
    update(id: number, patch: Partial<Omit<Category, 'id'>>): Promise<Category>;
    remove(id: number): Promise<void>;
  };
  chats: {
    list(accountId: number): Promise<ChatSummary[]>; // the account's chats, newest activity first
    // 50 messages older than beforeMessageId (null = newest), oldest first; opens public chats the account is not in
    history(accountId: number, chatId: number, beforeMessageId?: number | null): Promise<ChatItem[]>;
    // Manual message as the account; not counted by the outreach limiter
    send(accountId: number, chatId: number, text: string, replyToMessageId?: number | null): Promise<ChatItem>;
    search(accountId: number, query: string): Promise<ChatInfo[]>; // the account's chats + public chats/channels
    join(accountId: number, chatIdOrLink: number | string): Promise<ChatInfo>; // id, @username, t.me link or invite link
    leave(accountId: number, chatId: number): Promise<void>;
    // Any Telegram link → the chat and the message to open in-app (never joins)
    resolveLink(accountId: number, url: string): Promise<{ chat: ChatInfo; messageId: number | null }>;
    // A channel's discussion group (comments), null when the channel has none; join it with join(linked.chatId)
    discussion(accountId: number, channelIdOrLink: number | string): Promise<ChatInfo | null>;
    // Messages around a message (e.g. «Открыть публикацию» of a lead): ~20 before and ~20 after, oldest first
    around(accountId: number, chatId: number, messageId: number): Promise<ChatItem[]>;
    media(accountId: number, fileId: number): Promise<string>; // download a voice note; returns a tgmedia:// URL
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
    'Ты — помощник человека по имени {owner} и собираешь заявку клиента; представляйся его помощником (имя склоняй по-русски). Пиши коротко и по-человечески, на языке собеседника, по одному вопросу за раз. ' +
    'Цель — понять задачу и довести до заказа: что нужно, зачем, для кого, сроки, примеры. По услугам из каталога называй цену внутри вилки; ' +
    'для регулярной помощи предлагай подписку из каталога тарифов; цену нестандартных задач назовёт {owner} после изучения. ' +
    'Когда задача понятна или клиент просит цену, договор, созвон или живого человека — скажи, что передаёшь заявку руководителю, и он свяжется лично.',
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

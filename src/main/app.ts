// Application service: implements the IPC Api over db, Telegram engine and AI.
import { basename, join } from 'node:path';

import type { Db } from './db';
import type { TelegramEngine } from './telegram/types';
import type { Categorizer, DialogTurn, LeadAi, ManagerAi, TextSpinner } from './ai/types';
import { buildReport } from './pipeline/stats';
import { stubManagerAi } from './ai/manager';
import { stubCrmAi } from './ai/crm';
import { createCrm } from './pipeline/crm';
import type { CrmAi } from './ai/crm';
import { passthroughSpinner } from './ai/spinner';
import { createBroadcaster } from './pipeline/broadcaster';
import type { Api, AppEvent, AutopilotSettings, ProjectInput } from '../shared/types';
import {
  removeAccount,
  startLogin,
  submitCode,
  submitPassword,
  updateAccount,
} from './pipeline/accounts';
import { discover } from './pipeline/discovery';
import { categorizeLeads, scan } from './pipeline/scanner';
import type { SpeechService } from './ai/speech';
import { mediaUrlFromPath, storeMediaCopy, writeCallRecording } from './media';
import type { TgChat, TgMessage } from './telegram/types';
import { draftReply, sendMessage, sendVoiceMessage } from './pipeline/outreach';
import { transcribeIncomingVoice } from './voice/incoming';
import { createAutopilot } from './pipeline/autopilot';
import { createRealtime } from './pipeline/realtime';
import { createImporter } from './pipeline/importer';
import { createManagerAgent } from './pipeline/managerAgent';
import { stopChainOnIncoming } from './pipeline/sequence';
import type { Lead } from '../shared/types';
import type { ExecutorRegistry } from './executors/types';
import type { PaymentProvider } from './payments/types';
import { createOrders, stubExecutorRegistry } from './pipeline/orders';
import { createDossier } from './dossier';
import { createBilling } from './billing/billing';
import type { BillingApi } from './billing/billing';
import { createMemoryStore } from './memory/store';
import { ensureAgentSchema } from './agent/schema';
import { listAgentSteps } from './agent/store';
import { createDedupe, pruneFingerprints, PRUNE_INTERVAL_MS } from './dedupe';
import { createSpamChats, guardSpamJoins, spamChatReason, SPAM_CHAT_CHECK_MS } from './dedupe/spamChats';
import { createNews, NEWS_INTERVAL_MS } from './news';
import { CHECKIN_TICK_MS, createTrusted, isTrustedLead } from './trusted';
import { createAgentDefs } from './agent/defs';
import { createApprovals, type RunApprovedTool } from './agent/approvals';
import { executeApprovedTool, makeToolHost } from './agent/toolRunner';
import { createExecutors } from './executors/registry';
import { captionImage } from './memory/caption';
import { createAgentTasks, type AgentTask, type TaskFile } from './agent/tasks';
import { runSubagentTurn } from './agent/subagent';
import { createGroupHelper, helperAgent } from './groupHelper';
import { createKnowledge, knowledgeContext } from './knowledge';
import { createIntegrations } from './integrations';
import { createWorkerEmbedder } from './memory/embedder';
import { RICH_FORMAT } from './agent/style';
import { FIGURES_GUIDE } from './figures';
import { HELPER_DEFAULT_JEV, type HelperChat } from '../shared/types';
import { postSystemOne } from './ai/jev';
import { llmGateway } from './ai/gateway';
import { parseJsonFromLlm } from './ai/llm';
import { sendMediaMessage, waitForSendWindow } from './pipeline/outreach';
import { fileToDataUri } from './executors/images';
import { agentRole, createAiEngine } from './opencode/engine';
import type { ToolCatalogEntry } from './opencode/bridge';
import { TOOL_PREFIX } from './opencode/config';
import { isFreeModel } from './opencode/models';
import { renderFigures } from './figures';
import { buildAgentTools, freshTurnState } from './agent/tools';
import { createDelegateTool } from './agent/tools/delegate';
import type { ProviderConfig } from './opencode/config';
import type { AiModelsView, AiProvider } from '../shared/types';
import { createSkillsStore } from './skills';

export interface AppDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  manager?: ManagerAi;
  crmAi?: CrmAi;
  spinner?: TextSpinner;
  categorizer?: Categorizer; // demand map (Jev); absent in tests
  speech: SpeechService;
  dataDir: string;
  appDir?: string; // project root with shipped agents/ and skills/; the bundle in out/ cannot locate them itself
  opencodeRoot?: string; // the app's own OpenCode v2 lives here; absent in tests (no AI engine)
  emit: (e: AppEvent) => void;
  openExternal: (url: string) => Promise<void>;
  executors?: ExecutorRegistry;
  payments?: PaymentProvider;
  revealInFolder?: (path: string) => Promise<void>;
  pickFiles?: (opts: { title: string; extensions: string[] }) => Promise<string[]>; // the system file dialog; absent in tests
}

export type AppHandlers = Omit<Api, 'onEvent'> & { start(): Promise<void>; stop(): Promise<void>; relieveMemory(): void };

export function createApp(deps: AppDeps): AppHandlers {
  const { db, ai, openExternal, speech, dataDir } = deps;
  const engine = guardSpamJoins(deps.engine, db);
  ensureAgentSchema(db.raw, db);
  const getSettings = () => db.getSettings();
  const manager = deps.manager ?? stubManagerAi();
  const crmAi = deps.crmAi ?? stubCrmAi();
  const dossier = createDossier({ db, dataDir, settings: () => db.getSettings() });
  // one embedding model for client memory and knowledge bases (a second copy would double the memory it takes)
  const embedder = createWorkerEmbedder(dataDir);
  const knowledge = createKnowledge({
    db, embedder,
    // Jev picks which candidate passages actually answer the question (words and meaning only find candidates)
    rerank: async (question, passages) => {
      if (!getSettings().jevApiKey.trim()) throw new Error('нет ключа Jev');
      const criteria = Object.fromEntries(passages.map((p, i) => [`p${i + 1}`, p]));
      const data = await postSystemOne(getSettings, {
        state: { question: question.slice(0, 1500) },
        questions: { pick: { type: 'choice', instructions: 'Which passage best answers `question` — states the facts it asks about?', criteria } },
      });
      const probs = (data.answers?.pick as { probabilities?: Record<string, number> } | undefined)?.probabilities ?? {};
      return passages.map((_, i) => Number(probs[`p${i + 1}`] ?? 0));
    },
  });
  // the skill and the MCP server for Claude Code, Codex and other assistants; scripts run on this app's runtime
  const integrations = createIntegrations({ appDir: deps.appDir ?? process.cwd(), execPath: process.execPath });
  const memory = createMemoryStore({
    db,
    engine,
    dataDir,
    embedder,
    settings: () => db.getSettings(),
    emit: deps.emit,
  });
  const skills = createSkillsStore({
    dataDir,
    builtinDir: deps.appDir && join(deps.appDir, 'skills/agent'),
    db,
    getSettings,
    emit: deps.emit,
  });
  const crm = createCrm({ db, crmAi, emit: deps.emit });
  const emit = (e: AppEvent) => {
    deps.emit(e);
    if (e.type === 'message:new') {
      crm.onMessage(e.message);
      dossier.onMessage(e.message);
      memory.onMessage(e.message);
    }
    if (e.type === 'lead:new') {
      memory.ensureClient(e.lead);
    }
    if (e.type === 'lead:update') {
      crm.onLeadUpdate(e.lead);
      dossier.onLeadUpdate(e.lead);
    }
    if (e.type === 'order:update') {
      dossier.onOrder(e.order);
      memory.onOrder(e.order);
      void skills.onOrderUpdated(e.order);
    }
  };
  const spinner = deps.spinner ?? passthroughSpinner;
  let billing: BillingApi | undefined;
  const billingRef: { current?: BillingApi } = {};
  const dedupe = createDedupe({ db, emit });
  let dedupePruneTimer: ReturnType<typeof setInterval> | null = null;
  const spamChats = createSpamChats({ db, engine, emit });
  let spamChatTimer: ReturnType<typeof setInterval> | null = null;
  const news = createNews({ db, engine, emit, getSettings });
  let newsTimer: ReturnType<typeof setInterval> | null = null;
  const readNews = () => void news.runNow().catch((err) => console.error('news', err instanceof Error ? err.message : err));
  const checkSpamChats = () => void spamChats.check().catch((err) => console.error('spam chats', err));
  const pipeline = {
    db,
    engine,
    ai,
    speech,
    emit,
    manager,
    categorizer: deps.categorizer,
    dedupe,
    dossier,
    memory,
    get billing() {
      return billing;
    },
  };
  const payments = deps.payments ?? {
    create: async () => {
      throw new Error('Платежи не настроены');
    },
    status: async () => {
      throw new Error('Платежи не настроены');
    },
  };
  // The dossier gets order changes from the 'order:update' route above; passing it here too would log them twice
  const agentDefs = deps.appDir ? createAgentDefs(dataDir, join(deps.appDir, 'agents')) : createAgentDefs(dataDir);
  const approvalsHolder: { api?: ReturnType<typeof createApprovals> } = {};

  const ordersDeps = {
    ...pipeline,
    dossier: undefined,
    dataDir,
    payments,
    executors: deps.executors ?? stubExecutorRegistry(),
    skipOrderPaymentPoll: true,
    billingRef,
  };
  const orders = createOrders(ordersDeps);
  const sendToClient = async (leadId: number, text: string) => {
    await sendMessage(pipeline, leadId, text, 'dm', true);
  };
  const leadForClient = (clientId: number): number | null => {
    const row = db.raw.prepare('SELECT id FROM leads WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  };
  billing = createBilling({
    db,
    payments,
    emit,
    sendToClient,
    leadForClient,
    onOrderPaid: async (orderId) => {
      await orders.markPaid(orderId);
    },
  });
  billingRef.current = billing;
  const autopilot = createAutopilot(pipeline);
  // the AI engine: every model request goes through the app's own OpenCode v2 server
  const aiEngine = deps.opencodeRoot
    ? createAiEngine({
      root: deps.opencodeRoot,
      db,
      emit,
      getSettings,
      setSettings: (p) => db.setSettings(p),
      agents: () => agentDefs,
      approvals: () => approvalsHolder.api,
      toolCatalog: () => toolCatalog(),
    })
    : undefined;
  const managerAgent = createManagerAgent({
    ...pipeline,
    aiEngine,
    getBilling: () => billing, // `...pipeline` copies the billing getter's current (empty) value
    manager,
    crm,
    orders: {
      ...orders,
      handlePostManagerReply: orders.handlePostManagerReply.bind(orders),
      applyManagerIntent: orders.applyManagerIntent.bind(orders),
      requestPayment: orders.requestPayment.bind(orders),
    },
    dataDir,
    getSettings,
    executors: ordersDeps.executors,
    agents: agentDefs,
    getApprovals: () => approvalsHolder.api,
    getTasks: () => tasks,
    skills,
  });

  const makeHostForLead = (leadId: number) =>
    makeToolHost({
      db,
      engine,
      ai,
      speech,
      emit,
      getSettings,
      memory,
      billing,
      executors: ordersDeps.executors,
      orders: {
        applyManagerIntent: orders.applyManagerIntent.bind(orders),
        requestPayment: orders.requestPayment.bind(orders),
      },
      dataDir,
      skills,
      aiEngine,
    });

  approvalsHolder.api = createApprovals({
    db,
    emit,
    agents: agentDefs,
    getOperator: () => managerAgent.getOperator(),
    runTool: ((tool, args, leadId, agentName) =>
      executeApprovedTool(tool, args, leadId, agentName, makeHostForLead(leadId))) satisfies RunApprovedTool,
  });

  ordersDeps.executors = createExecutors(getSettings, {
    getSettings,
    agents: agentDefs,
    approvals: approvalsHolder.api,
    makeToolHost: makeHostForLead,
    emit,
    db,
  });
  // background subagent tasks: the agent hands work off and keeps talking; a finished result goes back to it for a check
  const TASK_INTROS = ['готово, смотри', 'вот, держи', 'сделал, глянь'];
  const reviewNote = (task: AgentTask, text: string, files: TaskFile[]) => [
    `Система: поручение #${task.id} («${task.agent}») готово${task.redoOf ? ` — это переделка #${task.redoOf}` : ''}. Клиент результат ещё не видел.`,
    `Поручение было: ${task.task}`,
    `Результат:\n<<<\n${text.slice(0, 12_000)}\n>>>`,
    files.length ? `Файлы: ${files.map((f) => basename(f.path)).join(', ')}` : '',
    'Проверь: это то, что просил клиент, без явных ошибок и выдумок? Если да — отправь его инструментом send_task_result ' +
      `(task_id ${task.id}, короткое живое вступление); текст результата не переписывай и не пересказывай.` +
      (task.redoOf ? ' Это уже переделка — отправь лучшее из двух или передай владельцу (handoff).' : ' Если результат не о том или с ошибкой — ' +
        `перепоручи через assign_task с redo_of ${task.id} и объясни, что исправить; клиенту пока ничего не пиши.`),
  ].filter(Boolean).join('\n\n');
  const tasks = createAgentTasks({
    db,
    dataDir,
    emit,
    run: async (task, dir) => {
      const lead = db.getLead(task.leadId);
      const context = db.listMessages(task.leadId).slice(-20)
        .map((m) => `${m.direction === 'in' ? 'Клиент' : 'Мы'}: ${m.text}`).join('\n');
      // the analyst and the solver see the client's recent photos themselves, not only their captions
      const vision = ['vision', 'smart'].includes(agentRole(agentDefs.get(task.agent).model));
      const photos = vision
        ? db.listMessages(task.leadId).filter((m) => m.direction === 'in' && m.mediaPath && /\.(jpe?g|png|webp)$/i.test(m.mediaPath)
          && m.date >= Date.now() - 3 * 86400_000).slice(-4)
        : [];
      const images = await Promise.all(photos.map((m) => fileToDataUri(m.mediaPath!)));
      const { text } = await runSubagentTurn({
        agentName: task.agent, task: task.task, context, leadId: task.leadId, clientId: lead.clientId, images,
        host: { ...makeHostForLead(task.leadId), taskDir: dir }, agents: agentDefs, approvals: approvalsHolder.api!, db, emit,
        aiEngine, sessionKey: `task:${task.id}`,
      });
      // figure and graph blocks become pictures in the result; a subfolder, so they are not sent again as attachments
      return renderFigures(text, { images: photos.map((m) => m.mediaPath!), dir: join(dir, 'figures') });
    },
    deliver: async (task, text, files) => {
      await managerAgent.checkin(task.leadId, reviewNote(task, text, files)).catch((err) => console.error('task review', err));
      const now = tasks.get(task.id);
      if (now?.deliveredAt) return; // sent or sent for a redo
      console.warn(`task #${task.id}: the agent did not send the result after its review — sending it directly`);
      // the agent did not take it (auto-replies off, handed off, the model failed): straight to the client as before
      const intro = TASK_INTROS[task.id % TASK_INTROS.length];
      await waitForSendWindow(pipeline, task.leadId);
      if (tasks.get(task.id)?.deliveredAt) return; // the agent's deferred turn got there while we waited
      await sendMediaMessage(pipeline, task.leadId, text ? `${intro}\n\n${text}` : intro, files, true);
      tasks.markDelivered(task.id);
    },
    fail: async (task, error) => {
      // «свои люди»: the agent keeps the dialog (the owner is the customer there); others go to the owner
      const current = db.getLead(task.leadId);
      const lead = isTrustedLead(db, current) ? current : db.updateLead(task.leadId, { handoff: true, handoffReason: `Поручение «${task.agent}» не выполнено: ${error}` });
      emit({ type: 'lead:update', lead });
      emit({ type: 'job', projectId: lead.projectId, stage: `Поручение #${task.id} (${task.agent}) не выполнено`, done: true, error });
    },
  });
  // the group assistant: Jev filters members' requests by the group's scenario and topic, an agent answers in the group
  const groupHelper = createGroupHelper({
    db, engine, dataDir, emit, getSettings, setSettings: (p) => db.setSettings(p),
    async isRequest(chat, message, picture) {
      const tasks = chat.kind === 'tasks';
      if (!getSettings().jevApiKey.trim()) return tasks && picture ? 0.6 : 0; // no Jev: only a photo in a tasks group counts
      const data = await postSystemOne(getSettings, {
        state: { message: message.slice(0, 1500), picture: picture.slice(0, 800), group: [chat.about, chat.instructions].filter(Boolean).join('\n').slice(0, 1200) },
        // the group's own question, or the scenario's
        questions: { request: { type: 'noul', instructions: chat.jevPrompt?.trim() || HELPER_DEFAULT_JEV[chat.kind] } },
      });
      return (data.answers?.request as { noul?: number } | undefined)?.noul ?? 0;
    },
    async describePhoto(path) {
      const gw = llmGateway();
      if (!gw) return { caption: '', tasks: [] };
      const raw = await gw.complete({
        role: 'vision', json: true, title: 'group-photo', images: [await fileToDataUri(path)],
        messages: [{ role: 'user', text: 'Что на фото? Если это учебное задание (учебник, тетрадь, контрольная, билет) — перечисли номера или обозначения ' +
          'отдельных задач на странице, как они там написаны. Ответ — только JSON: {"caption": "кратко по-русски: предмет, класс, тема, что на фото", "tasks": ["1", "2", "3"]}' }],
      });
      const v = parseJsonFromLlm(raw) as { caption?: string; tasks?: unknown[] };
      return { caption: String(v.caption ?? ''), tasks: Array.isArray(v.tasks) ? v.tasks.map(String).filter(Boolean) : [] };
    },
    // The group's pipeline: knowledge passages → helper agents (in parallel) → the main agent, or one request straight
    // to a model; the group's model, checking and checker on top of the agents' own settings
    async answer(chat, { key, task, query, photos, dir }) {
      const images = await Promise.all(photos.map((p) => fileToDataUri(p)));
      const skillText = (chat.skills ?? []).map((name) => {
        try {
          return `<skill name="${name}">\n${skills.loadSkillBody(name)}\n</skill>`;
        } catch {
          return '';
        }
      }).filter(Boolean).join('\n\n');
      // the member's own words find the passages: the job's service lines would only blur the search
      const hits = chat.knowledge?.length ? await knowledge.search(chat.knowledge, query || task, 6).catch(() => []) : [];
      const kb = chat.knowledge?.length ? knowledgeContext(hits, !!chat.knowledgeOnly) : '';
      const context = [`Группа в Telegram «${chat.title}»: ответ увидят все участники.`, skillText, kb].filter(Boolean).join('\n\n');
      const verifyMode = chat.verify && chat.verify !== 'agent' ? chat.verify : undefined;
      const main = helperAgent(chat);
      let text: string;
      if (chat.mode === 'model') {
        if (!aiEngine) throw new Error('ИИ-движок не подключён');
        let check = '';
        try {
          check = agentDefs.get(main).check;
        } catch {
          /* no such agent: the base checks only */
        }
        ({ text } = await aiEngine.direct({
          agent: `group:${chat.chatId}`, role: chat.kind === 'tasks' ? 'smart' : 'fast', model: chat.model || undefined,
          system: [RICH_FORMAT, chat.kind === 'tasks' ? FIGURES_GUIDE : ''].filter(Boolean).join('\n\n'), context,
          text: task, images, verifyMode: verifyMode ?? 'off', verifier: chat.verifier || undefined, check,
        }));
      } else {
        const run = (agentName: string, ctx: string, own: boolean) => runSubagentTurn({
          agentName, task, context: ctx, leadId: 0, clientId: null, images,
          host: { ...makeHostForLead(0), taskDir: dir }, agents: agentDefs, approvals: approvalsHolder.api!, db, emit, aiEngine,
          sessionKey: own ? key : `${key}:${agentName}`,
          ...(own ? { model: chat.model || undefined, verifyMode, verifier: chat.verifier || undefined } : {}),
        });
        const helpers = (chat.helpers ?? []).filter((h) => h !== main);
        const results = await Promise.all(helpers.map((h) => run(h, context, false).then((r) => `<helper agent="${h}">\n${r.text}\n</helper>`, (err) => {
          console.warn(`group helper: ${h} failed`, err instanceof Error ? err.message : err);
          return '';
        })));
        const found = results.filter(Boolean);
        ({ text } = await run(main, [context, found.length ? `Помощники уже поработали над запросом — проверь их результаты и используй в ответе:\n${found.join('\n\n')}` : ''].filter(Boolean).join('\n\n'), true));
      }
      return renderFigures(text, { images: photos, dir: join(dir, 'figures') });
    },
  });
  // every app tool an OpenCode agent may call through the bridge (definitions only; calls run with the turn's host)
  const toolCatalog = (): ToolCatalogEntry[] => {
    const host = { ...makeHostForLead(0), turnState: freshTurnState() };
    const tools = [...buildAgentTools(host), createDelegateTool({ ...host, agents: agentDefs, approvals: approvalsHolder.api!, primaryAgent: 'manager', clientContext: '' })];
    return tools.map((t) => ({ name: `${TOOL_PREFIX}${t.name}`, description: t.description, input: t.parameters }));
  };
  const aiProviders = (): ProviderConfig[] => {
    try {
      return JSON.parse(getSettings().aiProviders || '[]') as ProviderConfig[];
    } catch {
      return [];
    }
  };
  const providerView = (p: ProviderConfig): AiProvider => ({
    id: p.id, name: p.name, kind: p.kind, baseURL: p.baseURL ?? null, hasKey: !!p.apiKey, models: p.models?.length ?? 0,
  });
  const aiModelsView = (): AiModelsView => {
    const choice = aiEngine?.choice() ?? { main: getSettings().aiMainModel, helpers: [], useFree: getSettings().aiUseFree !== '0' };
    return {
      models: (aiEngine?.catalog() ?? []).map((m) => ({
        ref: `${m.providerID}/${m.id}`, providerID: m.providerID, name: m.name, vision: m.vision, tools: m.tools,
        variants: m.variants, costIn: m.costIn, costOut: m.costOut, context: m.context, free: isFreeModel(m),
        ...(aiEngine?.profileView(`${m.providerID}/${m.id}`) ?? { summary: null, strengths: [] }),
      })),
      main: choice.main,
      helpers: choice.helpers,
      useFree: choice.useFree,
    };
  };
  const operator = managerAgent.getOperator();
  const trusted = createTrusted({ db, engine, emit, checkin: (leadId, note) => managerAgent.checkin(leadId, note) });
  let checkinTimer: ReturnType<typeof setInterval> | null = null;
  const checkinTick = () => void trusted.checkinTick().catch((err) => console.error('checkin', err));
  const broadcaster = createBroadcaster({ db, engine, spinner, emit });
  const realtime = createRealtime({ ...pipeline, dataDir });
  const importer = createImporter({ db, engine, emit });

  return {
    async start() {
      const ids = db.listAccounts().filter((a) => a.status === 'authorized').map((a) => a.id);
      await engine.init(ids);
      engine.onPrivateMessage((accountId, msg) => {
        void (async () => {
          if (msg.senderUserId == null) return;
          const known = db.findLeadsByAuthor(msg.senderUserId);
          const leads = known.length ? known : [trusted.leadForIncoming(msg, accountId)].filter((l) => l != null);
          if (leads.length === 0) return;
          const lead = leads[0];
          const project = db.getProject(lead.projectId);
          let text = msg.text;
          let kind: import('../shared/types').MessageKind = 'text';
          let mediaPath: string | null = null;
          let durationSec: number | null = null;
          if (msg.voice) {
            const ingested = await transcribeIncomingVoice({
              dataDir,
              engine,
              speech,
              accountId,
              msg,
              emit,
              projectId: project.id,
            });
            text = ingested.text;
            mediaPath = ingested.mediaPath;
            durationSec = ingested.durationSec;
            kind = 'voice';
          } else if (msg.photo || msg.document) {
            await orders.ingestPrivateMedia(lead.id, accountId, msg);
            const fileId = msg.photo?.fileId ?? msg.document?.fileId;
            if (fileId != null) {
              const downloaded = await engine.downloadFile(accountId, fileId);
              const ext = msg.photo ? '.jpg' : '';
              mediaPath = storeMediaCopy(dataDir, downloaded, `in-${msg.chatId}-${msg.messageId}${ext}`);
            }
            // the agent reads text only: a photo becomes its description (product, example design, document…)
            if (msg.photo && mediaPath) {
              const { caption } = await captionImage(getSettings(), mediaPath).catch(() => ({ caption: '' }));
              text = `${text.trim() ? `${text.trim()}\n` : ''}[фото: ${caption || 'без описания'}]`;
            }
            if (!text.trim() && msg.photo) text = '[фото]';
            if (!text.trim() && msg.document) text = `[файл: ${msg.document.name}]`;
          }
          const message = db.addMessage({
            leadId: lead.id,
            accountId,
            direction: 'in',
            where: 'dm',
            kind,
            text,
            mediaPath,
            durationSec,
            tgChatId: msg.chatId,
            tgMessageId: msg.messageId,
            date: msg.date,
            auto: false,
          });
          stopChainOnIncoming(db, lead.id);
          const updated = db.updateLead(lead.id, { status: 'dialog' });
          emit({ type: 'message:new', message });
          emit({ type: 'lead:update', lead: updated });
          managerAgent.onIncoming(lead.id);
        })().catch((err) => console.error('private message', err));
      });
      if (deps.categorizer) {
        categorizeLeads({ db, emit }, deps.categorizer).catch((err) => console.error('categorize leads', err));
      }
      pruneFingerprints(db);
      dedupe.learnExistingLeads();
      spamChatTimer = setInterval(checkSpamChats, SPAM_CHAT_CHECK_MS);
      checkinTimer = setInterval(checkinTick, CHECKIN_TICK_MS);
      setTimeout(checkinTick, 90_000).unref?.();
      setTimeout(checkSpamChats, 60_000).unref?.();
      if (news.channels().length) {
        newsTimer = setInterval(readNews, NEWS_INTERVAL_MS);
        setTimeout(readNews, 120_000).unref?.();
      }
      dedupePruneTimer = setInterval(() => pruneFingerprints(db), PRUNE_INTERVAL_MS);
      // replies that were waiting on a timer when the app stopped: dialogs whose last message is incoming and fresh
      for (const leadId of db.leadsAwaitingReply(Date.now() - 2 * 3600_000)) managerAgent.onIncoming(leadId);
      if (aiEngine) {
        await aiEngine.start().catch((err) => {
          console.error('ai engine', err);
          emit({ type: 'job', projectId: db.listProjects()[0]?.id ?? 0, stage: 'ИИ-движок OpenCode не запустился', done: true, error: err instanceof Error ? err.message : String(err) });
        });
      }
      tasks.resume();
      // voice notes that failed to transcribe (key missing, provider error): one more try, then the agent answers
      void (async () => {
        for (const m of db.failedVoiceMessages(Date.now() - 24 * 3600_000)) {
          try {
            const text = await speech.transcribe(m.mediaPath!);
            db.updateMessageText(m.id, text);
            managerAgent.onIncoming(m.leadId);
          } catch (err) {
            console.error('retry voice', m.id, err instanceof Error ? err.message : err);
          }
        }
      })();
      // orders whose executor was running when the app stopped: run again (the result was never delivered)
      for (const o of db.listOrders().filter((x) => x.status === 'in_progress' || x.status === 'paid')) {
        orders.run(o.id).catch((err) => console.error('resume order', o.id, err));
      }
      realtime.start();
      // a reply waits in memory (the pause before answering, the agent's turn): after a restart, private dialogs whose
      // last word is the client's get answered — unless the work is already running and will report by itself
      const busy = new Set([
        ...db.listOrders().filter((o) => o.status === 'in_progress' || o.status === 'paid').map((o) => o.leadId),
        ...(db.raw.prepare("SELECT DISTINCT lead_id FROM agent_tasks WHERE status IN ('queued', 'running')").all() as { lead_id: number }[]).map((r) => r.lead_id),
      ]);
      // …and that the agent's session has not read yet (a message it saw and chose to leave unanswered stays so)
      const hasSessions = !!db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'opencode_sessions'").get();
      const unanswered = db.raw.prepare(`SELECT m.lead_id AS id FROM messages m
        JOIN (SELECT lead_id, MAX(id) AS mid FROM messages GROUP BY lead_id) last ON m.id = last.mid
        ${hasSessions ? "LEFT JOIN opencode_sessions s ON s.key = 'lead:' || m.lead_id" : ''}
        WHERE m.direction = 'in' AND m."where" = 'dm' AND m.date > ?${hasSessions ? ' AND COALESCE(s.synced_message_id, 0) < m.id' : ''}`)
        .all(Date.now() - 24 * 3600_000) as { id: number }[];
      for (const { id } of unanswered.filter((r) => !busy.has(r.id))) {
        try {
          managerAgent.onIncoming(id); // checks itself: auto-replies on or «свои люди», not handed over
        } catch (err) {
          console.error('resume dialog', id, err);
        }
      }
      if (unanswered.length) console.log(`resume: ${unanswered.length} dialog(s) waiting for an answer`);
      void groupHelper.start();
      knowledge.resume();
      autopilot.start();
      broadcaster.start();
      orders.startPoller();
      billing?.start();
    },

    relieveMemory() {
      memory.releaseModel();
    },
    async stop() {
      await aiEngine?.stop().catch((err) => console.error('ai engine stop', err));
      if (dedupePruneTimer) clearInterval(dedupePruneTimer);
      dedupePruneTimer = null;
      if (spamChatTimer) clearInterval(spamChatTimer);
      spamChatTimer = null;
      if (newsTimer) clearInterval(newsTimer);
      newsTimer = null;
      if (checkinTimer) clearInterval(checkinTimer);
      checkinTimer = null;
      billing?.stop();
      orders.stopPoller();
      broadcaster.stop();
      realtime.stop();
      groupHelper.stop();
      importer.stop();
      managerAgent.stop();
      autopilot.stop();
      crm.stop();
      dossier.stop();
      memory.stop();
      await engine.close();
    },

    settings: {
      get: async () => db.getSettings(),
      set: async (p) => db.setSettings(p),
    },

    accounts: {
      list: async () => db.listAccounts(),
      startLogin: (phone) => startLogin(pipeline, phone),
      submitCode: (id, code) => submitCode(pipeline, id, code),
      submitPassword: (id, pw) => submitPassword(pipeline, id, pw),
      update: (id, patch) => updateAccount(pipeline, id, patch),
      remove: (id) => removeAccount(pipeline, id),
    },

    projects: {
      list: async () => db.listProjects(),
      create: async (input: ProjectInput) => {
        const authorized = db.listAccounts().filter((a) => a.status === 'authorized').map((a) => a.id);
        const accountIds = input.accountIds.length > 0 ? input.accountIds : authorized;
        return db.createProject({ ...input, accountIds });
      },
      update: async (id, patch) => db.updateProject(id, patch),
      remove: async (id) => db.removeProject(id),
      suggestKeywords: (brief) => ai.suggestKeywords(brief),
    },

    sources: {
      list: async (projectId) => db.listSources(projectId),
      discover: (projectId) => discover(pipeline, projectId),
      scan: (projectId, sourceIds) => scan(pipeline, projectId, sourceIds),
      importCsv: (projectId, csv) => importer.importCsv(projectId, csv),
      add: async (projectId, linkOrUsername) => {
        const project = db.getProject(projectId);
        const accounts = db.listAccounts().filter(
          (a) => a.status === 'authorized' && (project.accountIds.includes(a.id) || project.accountIds.length === 0),
        );
        const accountId = accounts[0]?.id ?? db.listAccounts().find((a) => a.status === 'authorized')?.id;
        if (!accountId) throw new Error('Подключите рабочий аккаунт Telegram');
        let chat = await engine.resolveChat(accountId, linkOrUsername);
        // a channel is read through its discussion group: leads write in comments, not in the channel's posts
        if (chat.kind === 'channel') {
          const full = await engine.getChat(accountId, chat.chatId);
          if (full.linkedChatId) chat = await engine.getChat(accountId, full.linkedChatId);
        }
        const spam = spamChatReason(db, chat.chatId);
        if (spam) throw new Error(`«${chat.title}» — спам-чат (${spam}). Разблокировать можно в разделе «Спам»`);
        const source = db.addSource({
          projectId,
          tgChatId: chat.chatId,
          title: chat.title,
          username: chat.username,
          kind: chat.kind,
          memberCount: chat.memberCount,
          foundBy: 'manual',
          accountId,
          status: 'active',
        });
        emit({ type: 'source:update', source });
        return source;
      },
      setStatus: async (sourceId, status) => {
        const source = db.updateSource(sourceId, { status });
        emit({ type: 'source:update', source });
        return source;
      },
    },

    leads: {
      list: async (projectId, filter) => db.listLeads(projectId, filter),
      feedback: async (leadId, value) => db.updateLead(leadId, { feedback: value }),
      setStatus: async (leadId, status) => db.setLeadStatus(leadId, status),
      setHandoff: async (leadId, handoff) => {
        const lead = db.updateLead(leadId, { handoff, handoffReason: handoff ? 'Взято вручную' : null });
        emit({ type: 'lead:update', lead });
        // given back to the agent: it answers what the client wrote meanwhile
        if (!handoff && db.listMessages(leadId).at(-1)?.direction === 'in') managerAgent.onIncoming(leadId);
        return lead;
      },
    },

    messages: {
      list: async (leadId) => db.listMessages(leadId),
      draft: (leadId) => draftReply(pipeline, leadId),
      send: (leadId, text, where) => sendMessage(pipeline, leadId, text, where, false),
    },

    autopilot: {
      set: async (projectId, patch: Partial<AutopilotSettings>) => {
        const cur = db.getProject(projectId);
        const next: Partial<AutopilotSettings> = { ...patch };
        if (patch.enabled === true && !cur.autopilot.enabled) {
          next.nextRunAt = Date.now();
        }
        const project = db.updateProject(projectId, { autopilot: next });
        emit({ type: 'project:update', project });
        return project;
      },
      runNow: (projectId) => autopilot.runNow(projectId),
    },

    crm: {
      get: async (leadId) => db.getCard(leadId),
      update: async (leadId, patch) => {
        const card = db.updateCard(leadId, patch);
        emit({ type: 'crm:update', card });
        return card;
      },
      refresh: (leadId) => crm.refresh(leadId),
      generateBrief: (leadId) => crm.generateBrief(leadId),
      addNote: async (leadId, text) => {
        const lead = db.getLead(leadId);
        const message = db.addMessage({
          leadId, accountId: null, direction: 'out', where: 'dm', kind: 'note', text,
          tgChatId: lead.tgChatId, tgMessageId: null, date: Date.now(), auto: false,
        });
        emit({ type: 'message:new', message });
        return message;
      },
      board: async (projectId) => db.listCardLeads(projectId).map((lead) => ({ lead, card: db.getCard(lead.id) })),
    },
    voice: {
      send: (leadId, text, where) => sendVoiceMessage(pipeline, leadId, text, where, false),
      preview: async (text) => {
        const { path } = await speech.synthesize(text);
        return path;
      },
    },
    calls: {
      save: async (leadId, audio, mimeType, durationSec) => {
        const lead = db.getLead(leadId);
        const mediaPath = writeCallRecording(dataDir, leadId, audio, mimeType);
        let transcript = '';
        const prep = await speech.prepareForStt(mediaPath);
        try {
          transcript = await speech.transcribe(prep.path);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          transcript = '[созвон, не удалось расшифровать]';
          emit({
            type: 'job',
            projectId: lead.projectId,
            stage: 'Расшифровка созвона',
            done: true,
            error,
          });
        } finally {
          await prep.cleanup();
        }
        const message = db.addMessage({
          leadId,
          accountId: lead.accountId,
          direction: 'out',
          where: 'dm',
          kind: 'call',
          text: transcript,
          mediaPath,
          durationSec,
          tgChatId: lead.tgChatId,
          tgMessageId: null,
          date: Date.now(),
          auto: false,
        });
        emit({ type: 'message:new', message });
        return message;
      },
    },
    manager: {
      test: async (projectId, leadText, history, settings?) => {
        const project = db.getProject(projectId);
        const lead: Lead = {
          id: 0,
          projectId,
          sourceId: null,
          tgChatId: 0,
          tgMessageId: 0,
          authorUserId: 1,
          authorName: 'Тест',
          authorUsername: 'test',
          text: leadText,
          date: Date.now(),
          link: null,
          score: 80,
          label: 'demand',
          reason: '',
          feedback: null,
          status: 'dialog',
          accountId: null,
          clientId: null,
          repeatCount: 0,
          spamTemplateId: null,
          categoryId: null,
          sequenceStep: 0,
          nextStepAt: null,
          handoff: false,
          handoffReason: null,
          createdAt: Date.now(),
        };
        const op = await operator.turn(0, { dryRun: true, settings, leadOverride: lead, projectOverride: project });
        return {
          reply: op.reply ?? '',
          handoff: op.handoff,
          reason: op.reason,
          ...(op.order !== undefined ? { order: op.order } : {}),
        };
      },
    },
    broadcasts: {
      list: async () => db.listBroadcasts(),
      create: (input) => broadcaster.create(input),
      update: (id, patch) => broadcaster.update(id, patch),
      remove: (id) => broadcaster.remove(id),
      runNow: (id) => broadcaster.runNow(id),
    },
    clients: {
      list: async (search) => memory.listClients(search),
      get: async (clientId) => memory.getClient(clientId),
      byLead: async (leadId) => memory.clientForLead(leadId),
    },
    memory: {
      facts: async (clientId) => memory.listFacts(clientId).filter((f) => f.active),
      addFact: async (clientId, kind, text) => memory.remember(clientId, kind, text, 'owner'),
      removeFact: async (factId) => {
        memory.removeFact(factId);
      },
      episodes: async (clientId) => memory.listEpisodes(clientId),
      assets: async (clientId, query) => memory.listAssets(clientId, query),
      sendAsset: (leadId, assetId) => memory.sendAsset(leadId, assetId),
    },
    billing: {
      plans: async () => billing!.listPlans(),
      savePlan: async (plan) => billing!.savePlan(plan),
      removePlan: async (planId) => {
        billing!.removePlan(planId);
      },
      subscriptions: async (clientId) => billing!.listSubscriptions(clientId),
      subscribe: async (clientId, planId) => billing!.subscribe(clientId, planId),
      cancelSubscription: async (subscriptionId) => billing!.cancelSubscription(subscriptionId),
      payments: async (clientId) => billing!.listPayments(clientId),
      checkPayment: async (paymentId) => billing!.check(paymentId),
    },
    agents: {
      list: async () => agentDefs.list(),
      save: async (def) => agentDefs.save(def),
      remove: async (name) => {
        agentDefs.remove(name);
      },
      rules: async () => agentDefs.rules(),
      saveRules: async (text) => agentDefs.saveRules(text),
    },
    skills: {
      list: async () => skills.list(),
      save: async (skill) => skills.save(skill),
      remove: async (name) => {
        skills.remove(name);
      },
      approve: async (name) => skills.approve(name),
      removeLesson: async (name, index) => skills.removeLesson(name, index),
    },
    spam: {
      templates: async () => dedupe.listTemplates(),
      markSpam: async (leadId) => dedupe.markSpam(leadId),
      setTemplateStatus: async (id, status) => dedupe.setTemplateStatus(id, status),
      chats: async () => spamChats.list(),
      blockChat: (accountId, chatId) => spamChats.blockByOwner(accountId, chatId),
      unblockChat: async (tgChatId) => spamChats.unblock(tgChatId),
    },
    assistants: {
      status: async () => integrations.status(),
      install: async (target) => integrations.install(target),
      installTools: async () => integrations.installTools(),
    },
    knowledge: {
      bases: async () => knowledge.listBases(),
      createBase: async (name, description) => knowledge.createBase(name, description),
      updateBase: async (id, patch) => knowledge.updateBase(id, patch),
      removeBase: async (id) => knowledge.removeBase(id),
      docs: async (baseId) => knowledge.docs(baseId),
      addFiles: async (baseId) => {
        if (!deps.pickFiles) throw new Error('Выбор файлов доступен только в приложении');
        const paths = await deps.pickFiles({ title: 'Материалы для базы знаний', extensions: ['md', 'markdown', 'txt', 'html', 'htm', 'pdf'] });
        const added = [];
        for (const p of paths) added.push(knowledge.addFile(baseId, p));
        return added;
      },
      addUrl: async (baseId, url) => knowledge.addUrl(baseId, url),
      addText: async (baseId, title, text) => knowledge.addText(baseId, title || 'Текст', text, 'вставлен текст'),
      removeDoc: async (docId) => knowledge.removeDoc(docId),
      search: async (baseIds, query) => knowledge.search(baseIds, query, 6),
    },
    helper: {
      chats: async () => groupHelper.chats(),
      addChat: async (accountId, link) => {
        const found = await engine.resolveChat(accountId, link.trim());
        if (found.kind === 'private') throw new Error('Нужна группа или канал');
        // a channel: the helper works in its discussion group, where readers comment
        let chat = found;
        let channel: HelperChat['channel'] = null;
        if (found.kind === 'channel') {
          const full = found.linkedChatId === undefined ? await engine.getChat(accountId, found.chatId) : found;
          if (!full.linkedChatId) throw new Error('У канала нет обсуждения: включите комментарии (группу обсуждения) в настройках канала');
          chat = await engine.getChat(accountId, full.linkedChatId);
          channel = { chatId: found.chatId, title: found.title, username: found.username ?? null };
          if (!chat.isMember) await engine.joinChat(accountId, chat.chatId);
        }
        const rest = groupHelper.chats().filter((c) => c.chatId !== chat.chatId);
        return groupHelper.saveChats([...rest, { chatId: chat.chatId, title: chat.title, username: chat.username ?? null, accountId, enabled: true, channel }]);
      },
      saveChats: async (list) => groupHelper.saveChats(list),
      requests: async (limit, chatId) => groupHelper.requests(limit, chatId),
      scenarios: async () => groupHelper.scenarios(),
      saveScenario: async (def) => groupHelper.saveScenario(def),
      removeScenario: async (id) => groupHelper.removeScenario(id),
      test: async (chat, text, scenario) => groupHelper.test(chat, text, scenario),
      preview: async (chat, text, scenario) => groupHelper.preview(chat, text, scenario),
    },

    ai: {
      status: async () => aiEngine?.status() ?? { state: 'stopped', version: null, latest: null, url: null, message: 'ИИ-движок не подключён', checkedAt: null },
      models: async () => aiModelsView(),
      setModels: async ({ main, helpers, useFree }) => {
        db.setSettings({
          aiMainModel: main, aiHelperModels: JSON.stringify(helpers.filter((h) => h !== main)),
          ...(useFree === undefined ? {} : { aiUseFree: useFree ? '1' : '0' }),
        });
        return aiModelsView();
      },
      providers: async () => aiProviders().map(providerView),
      saveProvider: async (p) => {
        const list = aiProviders();
        const prev = list.find((x) => x.id === p.id);
        const visionGuess = (id: string) => /gemini|claude|gpt|grok|vision|vl|omni|qwen.*vl|4o/i.test(id);
        const next: ProviderConfig = {
          id: p.id.trim(), name: p.name.trim() || p.id.trim(), kind: p.kind,
          baseURL: p.kind === 'openai-compatible' ? p.baseURL?.trim() : undefined,
          apiKey: p.apiKey?.trim() || prev?.apiKey,
          models: p.kind === 'openai-compatible'
            ? (p.models ?? []).map((m) => m.trim()).filter(Boolean).map((m) => prev?.models?.find((x) => x.id === m)
              ?? { id: m, name: m, vision: visionGuess(m), tools: true, context: 128_000, output: 16_000, reasoning: [] })
            : undefined,
        };
        if (!/^[a-z0-9][a-z0-9_-]*$/i.test(next.id)) throw new Error('Идентификатор провайдера: латиница, цифры, дефис');
        if (next.kind === 'openai-compatible' && (!next.baseURL || !next.models?.length)) throw new Error('Укажите адрес API и хотя бы одну модель');
        db.setSettings({ aiProviders: JSON.stringify([...list.filter((x) => x.id !== next.id), next]) });
        await aiEngine?.reconfigure();
        return aiProviders().map(providerView);
      },
      removeProvider: async (id) => {
        db.setSettings({ aiProviders: JSON.stringify(aiProviders().filter((x) => x.id !== id)) });
        await aiEngine?.reconfigure();
        return aiProviders().map(providerView);
      },
      importOpencode: async () => {
        if (!aiEngine) throw new Error('ИИ-движок не подключён');
        return aiEngine.importUserOpencode();
      },
      checkUpdate: async () => {
        if (!aiEngine) throw new Error('ИИ-движок не подключён');
        return aiEngine.update();
      },
      stats: async (sinceDays) => aiEngine?.ledger.stats(Date.now() - sinceDays * 86400_000) ?? [],
      route: async (agent, task) => {
        if (!aiEngine) throw new Error('ИИ-движок не подключён');
        return aiEngine.route(agent, task);
      },
    },
    trusted: {
      list: async () => trusted.list(),
      save: async (c) => trusted.save(c),
      remove: async (username) => trusted.remove(username),
      checkinNow: () => trusted.checkinTick(new Date(), true),
    },
    news: {
      channels: async () => news.channels(),
      addChannel: async (link) => {
        const ch = await news.addChannel(link);
        newsTimer ??= setInterval(readNews, NEWS_INTERVAL_MS); // the first channel starts the hourly read
        return ch;
      },
      updateChannel: async (id, patch) => news.updateChannel(id, patch),
      removeChannel: async (id) => news.removeChannel(id),
      items: async (status) => news.items(status),
      setStatus: async (id, status) => news.setStatus(id, status),
      draft: (id, kind) => news.draft(id, kind),
      runNow: () => news.runNow(),
    },
    approvals: {
      list: async (status) => approvalsHolder.api!.list(status),
      decide: async (id, approve) => approvalsHolder.api!.decide(id, approve),
    },
    agent: {
      trace: async (leadId, limit) => listAgentSteps(db, leadId, limit ?? 100),
    },
    services: {
      list: async () => db.listServices(),
      create: async (input) => db.createService(input),
      update: async (id, patch) => db.updateService(id, patch),
      remove: async (id) => db.removeService(id),
    },
    orders: {
      list: async (leadId) => db.listOrders(leadId),
      create: async (leadId, serviceId, brief) => {
        const order = db.createOrder(leadId, serviceId, brief);
        emit({ type: 'order:update', order });
        return order;
      },
      update: async (id, patch) => {
        const order = db.updateOrder(id, patch);
        emit({ type: 'order:update', order });
        return order;
      },
      requestPayment: (id) => orders.requestPayment(id),
      markPaid: (id) => orders.markPaid(id),
      run: (id) => orders.run(id),
      deliver: (id) => orders.deliver(id),
      cancel: async (id) => {
        const order = db.updateOrder(id, { status: 'cancelled' });
        emit({ type: 'order:update', order });
        return order;
      },
    },
    dossier: {
      path: async (leadId) => dossier.path(leadId),
      open: async (leadId) => (deps.revealInFolder ?? (async () => {}))(dossier.path(leadId)),
    },
    stats: {
      report: async (period) => buildReport(db, period),
    },
    categories: {
      list: async () => db.listCategories(),
      create: async ({ name, description }) => db.createCategory(name, description),
      update: async (id, patch) => db.updateCategory(id, patch),
      remove: async (id) => db.removeCategory(id),
    },
    chats: {
      list: async (accountId) =>
        (await engine.listChats(accountId, 300)).map(({ chat, unreadCount, last }) => ({
          ...chatInfo(chat), spamReason: spamChatReason(db, chat.chatId), unreadCount, lastText: last?.text ?? null, lastDate: last?.date ?? null,
        })),
      history: async (accountId, chatId, before) =>
        (await engine.getMessagesBefore(accountId, chatId, before ?? null, 50)).map(chatItem),
      // Manual messages from the «Чаты» section are the owner typing, not outreach: no limiter (docs/decisions.md)
      send: async (accountId, chatId, text, replyTo) =>
        chatItem(replyTo ? await engine.replyInChat(accountId, chatId, replyTo, text) : await engine.sendToChat(accountId, chatId, text)),
      search: async (accountId, query) =>
        (await engine.searchChats(accountId, query)).map((c) => ({ ...chatInfo(c), spamReason: spamChatReason(db, c.chatId) })),
      join: async (accountId, target) => {
        const chat = typeof target === 'number' ? await engine.getChat(accountId, target) : await engine.resolveChat(accountId, target);
        if (!chat.isMember) await engine.joinChat(accountId, chat.chatId);
        return chatInfo(await engine.getChat(accountId, chat.chatId));
      },
      leave: (accountId, chatId) => engine.leaveChat(accountId, chatId),
      resolveLink: async (accountId, url) => {
        const { chat, messageId } = await engine.resolveLink(accountId, url);
        return { chat: { ...chatInfo(chat), spamReason: spamChatReason(db, chat.chatId) }, messageId };
      },
      discussion: async (accountId, target) => {
        const channel = typeof target === 'number' ? await engine.getChat(accountId, target) : await engine.resolveChat(accountId, target);
        const full = channel.linkedChatId === undefined ? await engine.getChat(accountId, channel.chatId) : channel;
        if (channel.kind !== 'channel' || !full.linkedChatId) return null;
        const chat = await engine.getChat(accountId, full.linkedChatId);
        return { ...chatInfo(chat), spamReason: spamChatReason(db, chat.chatId) };
      },
      around: async (accountId, chatId, messageId) =>
        (await engine.getMessagesAround(accountId, chatId, messageId, 40)).map(chatItem),
      media: async (accountId, fileId) =>
        mediaUrlFromPath(storeMediaCopy(dataDir, await engine.downloadFile(accountId, fileId), `chat-${fileId}`)),
    },
    shell: { openExternal: (url) => openExternal(url) },
  };
}

function chatInfo(c: TgChat) {
  return { chatId: c.chatId, title: c.title, username: c.username, kind: c.kind, memberCount: c.memberCount, isMember: c.isMember };
}

function chatItem(m: TgMessage) {
  return {
    messageId: m.messageId, date: m.date, text: m.text, senderName: m.senderName, senderUsername: m.senderUsername,
    isOutgoing: m.isOutgoing, voice: m.voice, replyToMessageId: m.replyToMessageId, link: m.link,
  };
}

function notYet(owner: string) {
  return async (): Promise<never> => {
    throw new Error(`not implemented (${owner})`);
  };
}

// Application service: implements the IPC Api over db, Telegram engine and AI.

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
import { scan } from './pipeline/scanner';
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
import { createDossier } from './dossier';

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
  emit: (e: AppEvent) => void;
  openExternal: (url: string) => Promise<void>;
  revealInFolder?: (path: string) => Promise<void>;
}

export type AppHandlers = Omit<Api, 'onEvent'> & { start(): Promise<void>; stop(): Promise<void> };

export function createApp(deps: AppDeps): AppHandlers {
  const { db, engine, ai, openExternal, speech, dataDir } = deps;
  const manager = deps.manager ?? stubManagerAi();
  const crmAi = deps.crmAi ?? stubCrmAi();
  const dossier = createDossier({ db, dataDir, settings: () => db.getSettings() });
  const crm = createCrm({ db, crmAi, emit: deps.emit });
  const emit = (e: AppEvent) => {
    deps.emit(e);
    if (e.type === 'message:new') {
      crm.onMessage(e.message);
      dossier.onMessage(e.message);
    }
    if (e.type === 'lead:update') {
      crm.onLeadUpdate(e.lead);
      dossier.onLeadUpdate(e.lead);
    }
    if (e.type === 'order:update') dossier.onOrder(e.order);
  };
  const spinner = deps.spinner ?? passthroughSpinner;
  const pipeline = { db, engine, ai, speech, emit, manager, categorizer: deps.categorizer, dossier };
  const autopilot = createAutopilot(pipeline);
  const managerAgent = createManagerAgent({ ...pipeline, manager, crm });
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
          const leads = db.findLeadsByAuthor(msg.senderUserId);
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
      realtime.start();
      autopilot.start();
      broadcaster.start();
    },

    async stop() {
      broadcaster.stop();
      realtime.stop();
      importer.stop();
      managerAgent.stop();
      autopilot.stop();
      crm.stop();
      dossier.stop();
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
        const chat = await engine.resolveChat(accountId, linkOrUsername);
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
          sequenceStep: 0,
          nextStepAt: null,
          handoff: false,
          handoffReason: null,
          createdAt: Date.now(),
        };
        const dialog: DialogTurn[] = [{ direction: 'in', text: leadText }, ...history];
        return manager.reply(project, lead, dialog, settings);
      },
    },
    broadcasts: {
      list: async () => db.listBroadcasts(),
      create: (input) => broadcaster.create(input),
      update: (id, patch) => broadcaster.update(id, patch),
      remove: (id) => broadcaster.remove(id),
      runNow: (id) => broadcaster.runNow(id),
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
      requestPayment: notYet('orders worker'),
      markPaid: notYet('orders worker'),
      run: notYet('orders worker'),
      deliver: notYet('orders worker'),
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
          ...chatInfo(chat), unreadCount, lastText: last?.text ?? null, lastDate: last?.date ?? null,
        })),
      history: async (accountId, chatId, before) =>
        (await engine.getMessagesBefore(accountId, chatId, before ?? null, 50)).map(chatItem),
      // Manual messages from the «Чаты» section are the owner typing, not outreach: no limiter (docs/decisions.md)
      send: async (accountId, chatId, text, replyTo) =>
        chatItem(replyTo ? await engine.replyInChat(accountId, chatId, replyTo, text) : await engine.sendToChat(accountId, chatId, text)),
      search: async (accountId, query) => (await engine.searchChats(accountId, query)).map(chatInfo),
      join: async (accountId, target) => {
        const chat = typeof target === 'number' ? await engine.getChat(accountId, target) : await engine.resolveChat(accountId, target);
        if (!chat.isMember) await engine.joinChat(accountId, chat.chatId);
        return chatInfo(await engine.getChat(accountId, chat.chatId));
      },
      leave: (accountId, chatId) => engine.leaveChat(accountId, chatId),
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

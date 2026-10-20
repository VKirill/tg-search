// Application service: implements the IPC Api over db, Telegram engine and AI.

import type { Db } from './db';
import type { TelegramEngine } from './telegram/types';
import type { LeadAi } from './ai/types';
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
import { draftReply, sendMessage } from './pipeline/outreach';
import { createAutopilot } from './pipeline/autopilot';
import { createRealtime } from './pipeline/realtime';
import { createImporter } from './pipeline/importer';

export interface AppDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  emit: (e: AppEvent) => void;
  openExternal: (url: string) => Promise<void>;
}

export type AppHandlers = Omit<Api, 'onEvent'> & { start(): Promise<void>; stop(): Promise<void> };

export function createApp(deps: AppDeps): AppHandlers {
  const { db, engine, ai, emit, openExternal } = deps;
  const pipeline = { db, engine, ai, emit };
  const autopilot = createAutopilot(pipeline);
  const realtime = createRealtime(pipeline);
  const importer = createImporter({ db, engine, emit });

  return {
    async start() {
      const ids = db.listAccounts().filter((a) => a.status === 'authorized').map((a) => a.id);
      await engine.init(ids);
      engine.onPrivateMessage((accountId, msg) => {
        if (msg.senderUserId == null) return;
        const leads = db.findLeadsByAuthor(msg.senderUserId);
        if (leads.length === 0) return;
        const lead = leads[0];
        const message = db.addMessage({
          leadId: lead.id,
          accountId,
          direction: 'in',
          where: 'dm',
          text: msg.text,
          tgChatId: msg.chatId,
          tgMessageId: msg.messageId,
          date: msg.date,
          auto: false,
        });
        const updated = db.updateLead(lead.id, { status: 'dialog' });
        emit({ type: 'message:new', message });
        emit({ type: 'lead:update', lead: updated });
      });
      realtime.start();
      autopilot.start();
    },

    async stop() {
      realtime.stop();
      importer.stop();
      autopilot.stop();
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

    broadcasts: {
      list: async () => db.listBroadcasts(),
      create: async () => {
        throw new Error('not implemented'); // broadcast worker
      },
      update: async () => {
        throw new Error('not implemented'); // broadcast worker
      },
      remove: async (id) => db.removeBroadcast(id),
      runNow: async () => {
        throw new Error('not implemented'); // broadcast worker
      },
    },
    shell: { openExternal: (url) => openExternal(url) },
  };
}

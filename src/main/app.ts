// Application service: implements the IPC Api over db, Telegram engine and AI.
// Stub: implemented by the pipeline worker (discovery, scanning, outreach, autopilot).

import type { Db } from './db';
import type { TelegramEngine } from './telegram/types';
import type { LeadAi } from './ai/types';
import type { Api, AppEvent } from '../shared/types';

export interface AppDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  emit: (e: AppEvent) => void;
  openExternal: (url: string) => Promise<void>;
}

export type AppHandlers = Omit<Api, 'onEvent'> & { start(): Promise<void>; stop(): Promise<void> };

const todo = async (): Promise<never> => {
  throw new Error('not implemented');
};

export function createApp({ db, openExternal }: AppDeps): AppHandlers {
  return {
    async start() {},
    async stop() {},
    settings: { get: async () => db.getSettings(), set: async (p) => db.setSettings(p) },
    accounts: { list: async () => db.listAccounts(), startLogin: todo, submitCode: todo, submitPassword: todo, update: todo, remove: todo },
    projects: { list: async () => db.listProjects(), create: async (i) => db.createProject(i), update: async (id, p) => db.updateProject(id, p), remove: async (id) => db.removeProject(id), suggestKeywords: todo },
    sources: { list: async (id) => db.listSources(id), discover: todo, scan: todo, add: todo, setStatus: async (id, s) => db.updateSource(id, { status: s }) },
    leads: { list: async (id, f) => db.listLeads(id, f), feedback: async (id, v) => db.updateLead(id, { feedback: v }), setStatus: async (id, s) => db.setLeadStatus(id, s) },
    messages: { list: async (id) => db.listMessages(id), draft: todo, send: todo },
    autopilot: { set: async (id, p) => db.updateProject(id, { autopilot: p } as any), runNow: todo },
    shell: { openExternal: async (url) => openExternal(url) },
  };
}

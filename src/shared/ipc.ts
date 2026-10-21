// IPC channel names: `${namespace}.${method}` for every async method of Api.
// Preload builds window.api from this list; main registers one handler per entry.

import type { Api } from './types';

type Methods<T> = { [K in keyof T]: T[K] extends (...a: any[]) => any ? K : never }[keyof T];
type ApiMap = { [N in Exclude<keyof Api, 'onEvent'>]: Methods<Api[N]>[] };

export const API_METHODS: ApiMap = {
  settings: ['get', 'set'],
  accounts: ['list', 'startLogin', 'submitCode', 'submitPassword', 'update', 'remove'],
  projects: ['list', 'create', 'update', 'remove', 'suggestKeywords'],
  sources: ['list', 'discover', 'scan', 'add', 'importCsv', 'setStatus'],
  leads: ['list', 'feedback', 'setStatus', 'setHandoff'],
  messages: ['list', 'draft', 'send'],
  autopilot: ['set', 'runNow'],
  crm: ['get', 'update', 'refresh', 'generateBrief', 'addNote', 'board'],
  voice: ['send', 'preview'],
  calls: ['save'],
  manager: ['test'],
  broadcasts: ['list', 'create', 'update', 'remove', 'runNow'],
  clients: ['list', 'get', 'byLead'],
  memory: ['facts', 'addFact', 'removeFact', 'episodes', 'assets', 'sendAsset'],
  billing: ['plans', 'savePlan', 'removePlan', 'subscriptions', 'subscribe', 'cancelSubscription', 'payments', 'checkPayment'],
  agent: ['trace'],
  agents: ['list', 'save', 'remove', 'rules', 'saveRules'],
  skills: ['list', 'save', 'remove', 'approve', 'removeLesson'],
  ai: ['status', 'models', 'setModels', 'providers', 'saveProvider', 'removeProvider', 'importOpencode', 'checkUpdate', 'route', 'stats'],
  helper: ['chats', 'addChat', 'saveChats', 'requests'],
  trusted: ['list', 'save', 'remove', 'checkinNow'],
  news: ['channels', 'addChannel', 'updateChannel', 'removeChannel', 'items', 'setStatus', 'draft', 'runNow'],
  approvals: ['list', 'decide'],
  spam: ['templates', 'markSpam', 'setTemplateStatus', 'chats', 'blockChat', 'unblockChat'],
  services: ['list', 'create', 'update', 'remove'],
  orders: ['list', 'create', 'update', 'requestPayment', 'markPaid', 'run', 'deliver', 'cancel'],
  dossier: ['path', 'open'],
  stats: ['report'],
  categories: ['list', 'create', 'update', 'remove'],
  chats: ['list', 'history', 'send', 'search', 'join', 'leave', 'media', 'around', 'discussion', 'resolveLink'],
  shell: ['openExternal'],
};

export const EVENT_CHANNEL = 'app:event';

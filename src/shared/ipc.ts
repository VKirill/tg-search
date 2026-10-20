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
  leads: ['list', 'feedback', 'setStatus'],
  messages: ['list', 'draft', 'send'],
  autopilot: ['set', 'runNow'],
  broadcasts: ['list', 'create', 'update', 'remove', 'runNow'],
  shell: ['openExternal'],
};

export const EVENT_CHANNEL = 'app:event';

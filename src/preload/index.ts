import { contextBridge, ipcRenderer } from 'electron';
import { API_METHODS, EVENT_CHANNEL } from '../shared/ipc';
import type { AppEvent } from '../shared/types';

const api: Record<string, unknown> = {
  onEvent(cb: (e: AppEvent) => void) {
    const listener = (_: unknown, e: AppEvent) => cb(e);
    ipcRenderer.on(EVENT_CHANNEL, listener);
    return () => ipcRenderer.off(EVENT_CHANNEL, listener);
  },
};
for (const [ns, methods] of Object.entries(API_METHODS)) {
  api[ns] = Object.fromEntries(
    (methods as string[]).map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`${ns}.${m}`, ...args)]),
  );
}

contextBridge.exposeInMainWorld('api', api);

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Db } from './db';
import { TdlEngine } from './telegram/engine';
import { OpenAiLeadAi } from './ai/leadAi';
import { JevQualifier } from './ai/jev';
import { createLeadAi } from './ai/hybrid';
import { createApp } from './app';
import { API_METHODS, EVENT_CHANNEL } from '../shared/ipc';
import type { AppEvent } from '../shared/types';

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    title: 'TG Search',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const db = new Db(join(dataDir, 'tg-search.db'));
  // Development defaults from the environment; values saved in Settings take priority.
  const s = db.getSettings();
  db.setSettings({
    tgApiId: s.tgApiId || process.env.TG_API_ID || '',
    tgApiHash: s.tgApiHash || process.env.TG_API_HASH || '',
    llmApiKey: s.llmApiKey || process.env.OPENROUTER_API_KEY || '',
    jevApiKey: s.jevApiKey || process.env.OPENLUX_API_KEY || '',
  });

  const emit = (e: AppEvent) => win?.webContents.send(EVENT_CHANNEL, e);
  const engine = new TdlEngine(join(dataDir, 'tdlib'), () => db.getSettings());
  const getSettings = () => db.getSettings();
  const llm = new OpenAiLeadAi(getSettings);
  const ai = createLeadAi(getSettings, llm, new JevQualifier(getSettings));
  const handlers = createApp({ db, engine, ai, emit, openExternal: (url) => shell.openExternal(url) });

  for (const [ns, methods] of Object.entries(API_METHODS)) {
    for (const m of methods as string[]) {
      const fn = (handlers as any)[ns][m] as (...a: unknown[]) => unknown;
      ipcMain.handle(`${ns}.${m}`, (_e, ...args) => fn(...args));
    }
  }

  createWindow();
  await handlers.start();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

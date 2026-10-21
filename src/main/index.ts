import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { Db } from './db';
import { TdlEngine } from './telegram/engine';
import { OpenAiLeadAi } from './ai/leadAi';
import { LlmSpinner } from './ai/spinner';
import { JevQualifier } from './ai/jev';
import { createLeadAi } from './ai/hybrid';
import { OpenAiManagerAi } from './ai/manager';
import { OpenAiCrmAi } from './ai/crm';
import { createApp } from './app';
import { API_METHODS, EVENT_CHANNEL } from '../shared/ipc';
import type { AppEvent } from '../shared/types';
import { startControlServer, pushControlEvent } from './control';
import { OpenAiSpeech } from './ai/speech';
import { JevCategorizer } from './ai/categorizer';
import { createExecutors } from './executors/registry';
import { setUsageSink } from './usage';
import { registerMediaProtocol, registerMediaSchemes } from './media';
import { YooKassaProvider } from './payments/yookassa';

registerMediaSchemes();

let win: BrowserWindow | null = null;
let control: { stop(): void } | null = null;

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
  registerMediaProtocol(app.getPath('userData'));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer
      .getSources({ types: ['screen'] })
      .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
      .catch(() => callback({}));
  });

  const dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  const db = new Db(join(dataDir, 'tg-search.db'));
  // Development defaults from the environment; values saved in Settings take priority.
  const s = db.getSettings();
  const openAiKey = process.env.OPENAI_API_KEY || '';
  db.setSettings({
    tgApiId: s.tgApiId || process.env.TG_API_ID || '',
    tgApiHash: s.tgApiHash || process.env.TG_API_HASH || '',
    llmApiKey: s.llmApiKey || process.env.OPENROUTER_API_KEY || '',
    jevApiKey: s.jevApiKey || process.env.OPENLUX_API_KEY || '',
    sttApiKey: s.sttApiKey || openAiKey,
    ttsApiKey: s.ttsApiKey || openAiKey,
    yookassaShopId: s.yookassaShopId || process.env.YOOKASSA_SHOP_ID || '',
    yookassaSecretKey: s.yookassaSecretKey || process.env.YOOKASSA_SECRET_KEY || '',
    auxApiKey: s.auxApiKey || process.env.NINEROUTER_API_KEY || '',
    falKey: s.falKey || process.env.FAL_KEY || '',
    glmApiKey: s.glmApiKey || process.env.ZAI_API_KEY || '',
    deepseekApiKey: s.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '',
    tavilyApiKey: s.tavilyApiKey || process.env.TAVILY_API_KEY || '',
  });

  const emit = (e: AppEvent) => {
    win?.webContents.send(EVENT_CHANNEL, e);
    pushControlEvent(e);
  };
  const engine = new TdlEngine(join(dataDir, 'tdlib'), () => db.getSettings());
  const getSettings = () => db.getSettings();
  const llm = new OpenAiLeadAi(getSettings);
  const ai = createLeadAi(getSettings, llm, new JevQualifier(getSettings));
  const spinner = new LlmSpinner(getSettings);
  const managerAi = new OpenAiManagerAi(getSettings);
  const crmAi = new OpenAiCrmAi(getSettings);
  const speech = new OpenAiSpeech(getSettings, dataDir);
  setUsageSink((u) => db.addUsage(u), getSettings);
  const handlers = createApp({
    db,
    engine,
    ai,
    manager: managerAi,
    crmAi,
    spinner,
    speech,
    categorizer: new JevCategorizer(getSettings),
    executors: createExecutors(getSettings),
    dataDir,
    emit,
    openExternal: (url) => shell.openExternal(url),
    payments: new YooKassaProvider(getSettings),
    revealInFolder: async (path) => {
      shell.showItemInFolder(path);
    },
  });

  for (const [ns, methods] of Object.entries(API_METHODS)) {
    for (const m of methods as string[]) {
      const fn = (handlers as any)[ns][m] as (...a: unknown[]) => unknown;
      ipcMain.handle(`${ns}.${m}`, (_e, ...args) => fn(...args));
    }
  }

  control = await startControlServer({
    handlers,
    dataDir,
    version: app.getVersion(),
  });

  createWindow();
  await handlers.start();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('before-quit', async () => {
  control?.stop();
  control = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

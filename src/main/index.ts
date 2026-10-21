import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import { setFigureHost } from './figures';
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
import { startMemoryWatch, teeConsoleToFile } from './diagnostics';
import { registerMediaProtocol, registerMediaSchemes } from './media';
import { YooKassaProvider } from './payments/yookassa';

registerMediaSchemes();

let win: BrowserWindow | null = null;
const SOCIAL = 'persist:social'; // the session of the channel assistant's browser (Facebook, Instagram logins)
const isTelegramLink = (url: string) => /^(tg:|https?:\/\/(www\.)?(t|telegram)\.me\/)/i.test(url);
// Telegram links open inside the app («Чаты»); other sites (payments, my.telegram.org) in the browser
const openLink = (url: string) => {
  if (isTelegramLink(url)) win?.webContents.send(EVENT_CHANNEL, { type: 'link:open', url } satisfies AppEvent);
  else void shell.openExternal(url);
};
let control: { stop(): void } | null = null;
let stopApp: (() => Promise<void>) | null = null;
let stopped = false;

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
    openLink(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:') || url.startsWith(process.env.ELECTRON_RENDERER_URL ?? '\0')) return;
    e.preventDefault();
    openLink(url);
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
  teeConsoleToFile(dataDir);
  // graphs and figures in solutions: SVG drawn in a hidden offscreen window, task figures cut out of the client's photo
  setFigureHost({
    async svgToPng(svg, width, height) {
      const w = new BrowserWindow({ show: false, width, height, webPreferences: { offscreen: true } });
      try {
        await w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`)}`);
        return (await w.webContents.capturePage({ x: 0, y: 0, width, height })).toPNG();
      } finally {
        w.destroy();
      }
    },
    async crop(path, [l, t, r, b]) {
      const img = nativeImage.createFromPath(path);
      const { width, height } = img.getSize();
      if (!width) throw new Error(`не открыть картинку ${path}`);
      const rect = { x: Math.round((width * l) / 100), y: Math.round((height * t) / 100), width: Math.round((width * (r - l)) / 100), height: Math.round((height * (b - t)) / 100) };
      const out = img.crop(rect);
      return (rect.width < 600 ? out.resize({ width: 600, quality: 'best' }) : out).toPNG(); // a small figure stays readable
    },
  });
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
    appDir: app.getAppPath(),
    opencodeRoot: join(dataDir, 'opencode'),
    emit,
    openExternal: async (url) => openLink(url),
    payments: new YooKassaProvider(getSettings),
    // the channel assistant's browser: a separate persistent session where the owner logs in to Facebook / Instagram once
    openBrowser: async (url) => {
      const w = new BrowserWindow({ width: 1100, height: 860, title: 'Вход для помощника каналов', webPreferences: { partition: SOCIAL } });
      await w.loadURL(url);
    },
    browse: async (url) => {
      const w = new BrowserWindow({ show: false, width: 1280, height: 2400, webPreferences: { partition: SOCIAL, offscreen: true } });
      try {
        await w.loadURL(url);
        // feeds load lazily: wait and scroll a few screens down
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 2500));
          await w.webContents.executeJavaScript('window.scrollBy(0, 2000)');
        }
        return String(await w.webContents.executeJavaScript('document.body.innerText')).slice(0, 60_000);
      } finally {
        w.destroy();
      }
    },
    pickFiles: async ({ title, extensions }) => {
      const r = await dialog.showOpenDialog({ title, properties: ['openFile', 'multiSelections'], filters: [{ name: 'Материалы', extensions }] });
      return r.canceled ? [] : r.filePaths;
    },
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
  stopApp = () => handlers.stop();
  await handlers.start();
  startMemoryWatch({
    dataDir,
    processes: () => app.getAppMetrics().map((m) => ({ type: m.type, pid: m.pid, mb: m.memory.workingSetSize / 1024 })),
    relieve: () => handlers.relieveMemory(),
    critical: () => app.quit(),
  });
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

// TDLib threads must be closed before exit: otherwise its mutexes are destroyed under running threads and
// Electron dies with SIGABRT/SIGSEGV on every quit (crash reports of 2026-10-21)
app.on('before-quit', (e) => {
  control?.stop();
  control = null;
  if (stopped || !stopApp) return;
  e.preventDefault();
  stopped = true;
  const timeout = new Promise<void>((r) => setTimeout(r, 5000));
  Promise.race([stopApp().catch((err) => console.error('stop', err)), timeout]).finally(() => app.quit());
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => app.quit());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

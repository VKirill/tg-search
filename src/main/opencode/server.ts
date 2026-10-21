// The app's private OpenCode v2 server: own binary (runtime.ts), own HOME/XDG dirs, own config dir and password;
// it never sees the user's opencode, home directory or skills. Supervised: restarted if it dies, health-checked,
// updated daily with rollback when a new version does not come up.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { OpencodeRuntime } from './runtime';

export interface OpencodeStatus {
  state: 'stopped' | 'installing' | 'starting' | 'ready' | 'error';
  version: string | null;
  latest: string | null;
  url: string | null;
  message: string | null;
  checkedAt: number | null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

export interface OpencodeServerDeps {
  root: string; // userData/opencode
  runtime: OpencodeRuntime;
  configDir: () => string; // written by config.ts before start
  extraEnv: () => Record<string, string>; // bridge URL/token for the plugin
  onStatus: (s: OpencodeStatus) => void;
}

export function createOpencodeServer(deps: OpencodeServerDeps) {
  const home = join(deps.root, 'home');
  for (const d of ['home', 'config', 'data', 'state', 'cache', 'work']) mkdirSync(join(home, d), { recursive: true });
  const password = randomBytes(24).toString('base64url');
  let child: ChildProcess | null = null;
  let stopping = false;
  let restarts = 0;
  let status: OpencodeStatus = { state: 'stopped', version: null, latest: null, url: null, message: null, checkedAt: null };
  const set = (patch: Partial<OpencodeStatus>) => {
    status = { ...status, ...patch };
    deps.onStatus(status);
  };
  const auth = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;

  async function call<T = any>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!status.url) throw new Error('ИИ-движок OpenCode ещё не запущен');
    const res = await fetch(`${status.url}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenCode ${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async function healthy(): Promise<boolean> {
    try {
      await call('GET', '/api/model', undefined, 10_000);
      return true;
    } catch {
      return false;
    }
  }

  async function launch(binary: string): Promise<void> {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      HOME: join(home, 'home'),
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: join(home, 'cache'),
      OPENCODE_CONFIG_DIR: deps.configDir(),
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_SERVER_PASSWORD: password,
      ...deps.extraEnv(),
    };
    set({ state: 'starting', url: null, message: null });
    const proc = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], {
      env, cwd: join(home, 'work'), stdio: ['ignore', 'ignore', 'pipe'],
    });
    child = proc;
    let lastErr = '';
    proc.stderr?.on('data', (b: Buffer) => {
      lastErr = (lastErr + b.toString()).slice(-2000);
    });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      if (stopping) return;
      set({ state: 'error', url: null, message: `OpenCode остановился (код ${code}). ${lastErr.split('\n').filter(Boolean).pop() ?? ''}` });
      // a crash restarts the server, a few times in a row at most
      if (restarts++ < 5) setTimeout(() => void start().catch(() => {}), 3000 * restarts);
    });
    set({ url });
    for (let i = 0; i < 60; i++) {
      if (await healthy()) {
        restarts = 0;
        set({ state: 'ready', version: deps.runtime.state().current, message: null });
        return;
      }
      if (!child) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    proc.kill();
    throw new Error(`OpenCode не отвечает после запуска. ${lastErr.split('\n').filter(Boolean).slice(-2).join(' ')}`);
  }

  async function start(): Promise<void> {
    stopping = false;
    let binary = deps.runtime.binary();
    if (!binary) {
      set({ state: 'installing', message: 'Устанавливаю ИИ-движок OpenCode' });
      binary = await deps.runtime.ensure((stage) => set({ state: 'installing', message: stage }));
    }
    try {
      await launch(binary);
    } catch (err) {
      set({ state: 'error', message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async function stop(): Promise<void> {
    stopping = true;
    const proc = child;
    child = null;
    if (!proc) return;
    proc.kill('SIGTERM');
    await new Promise<void>((r) => {
      const t = setTimeout(() => {
        proc.kill('SIGKILL');
        r();
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(t);
        r();
      });
    });
    set({ state: 'stopped', url: null });
  }

  // Daily: install a newer v2 beside the current one, switch, and roll back if it does not come up healthy
  async function update(): Promise<string> {
    const st = deps.runtime.state();
    const fresh = await deps.runtime.checkForUpdate((stage) => set({ message: stage }));
    set({ latest: deps.runtime.state().latest, checkedAt: Date.now(), message: null });
    if (!fresh) return `OpenCode ${st.current} — последняя версия`;
    const binary = deps.runtime.activate(fresh);
    await stop();
    try {
      await launch(binary);
      return `OpenCode обновлён до ${fresh}`;
    } catch (err) {
      const back = deps.runtime.rollback();
      if (back) await launch(back);
      throw new Error(`OpenCode ${fresh} не запустился, вернул ${st.current}: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  return { start, stop, restart, update, call, status: () => status, workDir: () => join(home, 'work') };
}

export type OpencodeServer = ReturnType<typeof createOpencodeServer>;

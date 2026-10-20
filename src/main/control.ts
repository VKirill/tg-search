// Local HTTP control API for Claude / tgs CLI (127.0.0.1 only).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { API_METHODS } from '../shared/ipc';
import type { Api, AppEvent } from '../shared/types';

const PREFERRED_PORT = 47621;
const BODY_LIMIT = 5 * 1024 * 1024;
const CONTROL_FILE = 'control.json';

export type ControlHandlers = Omit<Api, 'onEvent'>;

export interface ControlServerOptions {
  handlers: ControlHandlers;
  dataDir: string;
  version: string;
}

export interface ControlServer {
  port: number;
  token: string;
  stop(): void;
}

type SseClient = ServerResponse;

const sseClients = new Set<SseClient>();

export function pushControlEvent(event: AppEvent): void {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(data);
    } catch {
      sseClients.delete(res);
    }
  }
}

function authOk(req: IncomingMessage, token: string): boolean {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return false;
  const given = h.slice(7);
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > BODY_LIMIT) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isKnownMethod(path: string): { ns: string; method: string } | null {
  const m = path.match(/^\/api\/([^.]+)\.(.+)$/);
  if (!m) return null;
  const ns = m[1];
  const method = m[2];
  const methods = (API_METHODS as Record<string, string[]>)[ns];
  if (!methods || !methods.includes(method)) return null;
  return { ns, method };
}

function listApiMethods(): { path: string; namespace: string; method: string }[] {
  const out: { path: string; namespace: string; method: string }[] = [];
  for (const [ns, methods] of Object.entries(API_METHODS)) {
    for (const method of methods as string[]) {
      out.push({ path: `/api/${ns}.${method}`, namespace: ns, method });
    }
  }
  return out;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

async function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const token = randomBytes(32).toString('hex');
  let server: Server;
  let port: number;
  try {
    server = await listenOn(PREFERRED_PORT);
    port = PREFERRED_PORT;
  } catch {
    port = await findFreePort();
    server = await listenOn(port);
  }

  const controlPath = join(opts.dataDir, CONTROL_FILE);
  writeFileSync(
    controlPath,
    JSON.stringify({ port, token, pid: process.pid, version: opts.version }, null, 2) + '\n',
    { mode: 0o600 },
  );

  const { handlers } = opts;

  server.on('request', async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      if (!authOk(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, version: opts.version });
    }

    if (req.method === 'GET' && pathname === '/api') {
      if (!authOk(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      return sendJson(res, 200, { ok: true, methods: listApiMethods() });
    }

    if (req.method === 'GET' && pathname === '/events') {
      if (!authOk(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && pathname.startsWith('/api/')) {
      if (!authOk(req, token)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const known = isKnownMethod(pathname);
      if (!known) return sendJson(res, 404, { ok: false, error: 'unknown method' });
      try {
        const raw = await readBody(req);
        let args: unknown[] = [];
        if (raw.trim()) {
          const parsed = JSON.parse(raw) as { args?: unknown[] };
          if (!Array.isArray(parsed.args)) throw new Error('body must be {"args":[...]}');
          args = parsed.args;
        }
        const nsHandlers = (handlers as Record<string, Record<string, (...a: unknown[]) => unknown>>)[known.ns];
        const fn = nsHandlers?.[known.method];
        if (!fn) return sendJson(res, 404, { ok: false, error: 'unknown method' });
        const result = await fn(...args);
        return sendJson(res, 200, { ok: true, result });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return sendJson(res, 400, { ok: false, error: message });
      }
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  });

  return {
    port,
    token,
    stop() {
      for (const client of sseClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      sseClients.clear();
      server.close();
      if (existsSync(controlPath)) unlinkSync(controlPath);
    },
  };
}

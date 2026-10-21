#!/usr/bin/env node
// TG Search MCP server (stdio): lets any MCP client — Claude Code, Codex, Cursor, Claude Desktop — set up and run the
// app through its local control API. Dependency-free: JSON-RPC 2.0, one message per line on stdin/stdout.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOT_RUNNING = 'Приложение TG Search не запущено — откройте его на Mac и повторите.';
const PROTOCOL = '2025-06-18';

// The API reference shipped with the skill: next to this script (repo, app bundle) or in the installed skill
const REFS = [
  join(HERE, '..', 'skills', 'tg-search', 'references'),
  join(HERE, 'skill', 'references'),
  join(homedir(), '.claude', 'skills', 'tg-search', 'references'),
  join(homedir(), '.codex', 'skills', 'tg-search', 'references'),
].find((p) => existsSync(join(p, 'api.md')));

function control() {
  const dir = process.env.TG_SEARCH_DATA || join(homedir(), 'Library', 'Application Support', 'TG Search');
  const path = join(dir, 'control.json');
  if (!existsSync(path)) throw new Error(NOT_RUNNING);
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function request(method, pathname, body) {
  const ctrl = control();
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${ctrl.port}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${ctrl.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(NOT_RUNNING);
  }
  if (res.status === 401) throw new Error(NOT_RUNNING);
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function call(method, args) {
  const { status, data } = await request('POST', `/api/${method}`, { args: Array.isArray(args) ? args : args === undefined ? [] : [args] });
  if (status === 404) throw new Error(`Неизвестный метод: ${method}. Список — инструмент describe.`);
  if (!data.ok) throw new Error(data.error || 'ошибка API');
  return data.result;
}

async function events(seconds) {
  const ctrl = control();
  const res = await fetch(`http://127.0.0.1:${ctrl.port}/events`, { headers: { Authorization: `Bearer ${ctrl.token}` } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const out = [];
  let buf = '';
  const deadline = Date.now() + Math.min(60, Math.max(1, seconds)) * 1000;
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ done: false }), 500))]);
    if (value) {
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const block of parts) for (const line of block.split('\n')) if (line.startsWith('data: ')) out.push(line.slice(6));
    }
    if (done) break;
  }
  await reader.cancel().catch(() => {});
  return out;
}

// The API reference for a namespace (or the whole list): signatures with comments from the app's contracts
function describe(namespace) {
  if (!REFS) return 'Справочник API не найден: установите навык tg-search (Настройки → ИИ-ассистенты) или вызовите call с методом из списка ниже.';
  const api = readFileSync(join(REFS, 'api.md'), 'utf8');
  if (!namespace) return api;
  const re = new RegExp(`\\n  ${namespace}: \\{[\\s\\S]*?\\n  \\};`);
  const m = re.exec(api);
  return m ? m[0].trim() : `Нет раздела «${namespace}». Разделы — в describe без аргументов.`;
}

const TOOLS = [
  {
    name: 'status',
    description: 'Состояние TG Search: запущено ли приложение, аккаунты Telegram, тематики, ИИ-движок, группы помощника. Начинайте с него.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const [health, accounts, projects, ai, groups] = await Promise.all([
        request('GET', '/health').then((r) => r.data),
        call('accounts.list'),
        call('projects.list'),
        call('ai.status').catch(() => null),
        call('helper.chats').catch(() => []),
      ]);
      return {
        health,
        accounts: accounts.map((a) => ({ id: a.id, username: a.username, status: a.status, sentToday: a.sentToday, dailyLimit: a.dailyLimit })),
        projects: projects.map((p) => ({ id: p.id, name: p.name, task: p.task, autopilot: p.autopilot?.enabled })),
        ai,
        groups: groups.map((g) => ({ chatId: g.chatId, title: g.title, scenario: g.scenario, enabled: g.enabled })),
      };
    },
  },
  {
    name: 'describe',
    description: 'Справочник API приложения: методы с параметрами и типами. Без аргумента — все разделы; с namespace (projects, leads, helper, knowledge, ai, agents, skills, settings…) — один раздел. Читайте перед call.',
    inputSchema: { type: 'object', properties: { namespace: { type: 'string', description: 'Раздел API, например helper' } } },
    run: async ({ namespace }) => describe(namespace),
  },
  {
    name: 'call',
    description: 'Вызвать метод API: method — «раздел.метод» (например helper.chats, projects.create), args — массив аргументов по сигнатуре из describe. Возвращает результат метода.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'Например knowledge.createBase' },
        args: { type: 'array', description: 'Аргументы по порядку, например ["Справка Директа", "документация"]', items: {} },
      },
      required: ['method'],
    },
    run: async ({ method, args }) => call(method, args ?? []),
  },
  {
    name: 'events',
    description: 'События приложения за N секунд (новые лиды, сообщения, работа агента, статус ИИ-движка), до 60.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'Сколько секунд слушать, по умолчанию 10' } } },
    run: async ({ seconds }) => events(seconds ?? 10),
  },
];

const INSTRUCTIONS = [
  'TG Search — приложение для macOS: ищет клиентов в Telegram, ведёт диалоги ИИ-менеджером, выполняет заказы и работает помощником в группах.',
  'Начните со status, затем describe нужного раздела, затем call. Никогда не выводите ключи и токены из settings.',
  'Действия, которые пишут людям в Telegram (рассылки, автопилот, сообщения, помощник в группе), включайте только после явного согласия пользователя.',
].join(' ');

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params?.protocolVersion || PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'tg-search', version: '1.0.0' },
      instructions: INSTRUCTIONS,
    } });
  }
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Нет инструмента ${params?.name}` } });
    try {
      const out = await tool.run(params.arguments ?? {});
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    } catch (err) {
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true } });
    }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Метод не поддерживается: ${method}` } });
}

// the client closed the pipe or the input ended: leave quietly once every request is answered
process.stdout.on('error', () => process.exit(0));
let pending = 0;
let ended = false;
const maybeExit = () => ended && pending === 0 && process.exit(0);
process.stdin.on('end', () => {
  ended = true;
  maybeExit();
});

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    pending++;
    void handle(msg).finally(() => {
      pending--;
      maybeExit();
    });
  }
});

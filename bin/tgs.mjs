#!/usr/bin/env node
// TG Search local control CLI (reads control.json from the app's userData).

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const NOT_RUNNING = 'Приложение TG Search не запущено — откройте его';

function defaultDataDir() {
  if (process.env.TG_SEARCH_DATA) return process.env.TG_SEARCH_DATA;
  return join(homedir(), 'Library', 'Application Support', 'TG Search');
}

function loadControl() {
  const path = join(defaultDataDir(), 'control.json');
  if (!existsSync(path)) {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
  try {
    return { ...JSON.parse(readFileSync(path, 'utf8')), path };
  } catch {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
}

function parseArg(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function request(ctrl, method, pathname, body) {
  const url = `http://127.0.0.1:${ctrl.port}${pathname}`;
  const headers = { Authorization: `Bearer ${ctrl.token}` };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`invalid JSON from server (${res.status})`);
  }
  if (res.status === 401) {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
  return { status: res.status, data };
}

async function apiCall(ctrl, nsMethod, args = []) {
  const { status, data } = await request(ctrl, 'POST', `/api/${nsMethod}`, { args });
  if (status === 404) {
    console.error(`Неизвестный метод: ${nsMethod}`);
    process.exit(1);
  }
  if (!data.ok) {
    console.error(data.error || 'ошибка API');
    process.exit(1);
  }
  return data.result;
}

function printOut(value, pretty) {
  const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  console.log(text);
}

function hasFlag(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  return argv[i + 1];
}

async function cmdStatus(ctrl, pretty) {
  const health = await request(ctrl, 'GET', '/health');
  const accounts = await apiCall(ctrl, 'accounts.list', []);
  const projects = await apiCall(ctrl, 'projects.list', []);
  printOut(
    {
      health: health.data,
      accounts: accounts.map((a) => ({
        id: a.id,
        phone: a.phone,
        status: a.status,
        username: a.username,
        sentToday: a.sentToday,
        dailyLimit: a.dailyLimit,
      })),
      projects: projects.map((p) => ({
        id: p.id,
        name: p.name,
        task: p.task,
        autopilotEnabled: p.autopilot.enabled,
      })),
    },
    pretty,
  );
}

async function cmdEvents(ctrl, seconds) {
  const url = `http://127.0.0.1:${ctrl.port}/events`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ctrl.token}` } });
  if (res.status === 401) {
    console.error(NOT_RUNNING);
    process.exit(1);
  }
  const deadline = Date.now() + seconds * 1000;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (Date.now() < deadline) {
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ done: false, value: undefined }), 500)),
    ]);
    if (value) {
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      for (const block of parts) {
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) {
            console.log(line.slice(6));
          }
        }
      }
    }
    if (done) break;
  }
  try {
    reader.cancel();
  } catch {
    /* ignore */
  }
}

async function cmdImport(ctrl, projectId, filePath) {
  const csv = readFileSync(resolve(filePath), 'utf8');
  const result = await apiCall(ctrl, 'sources.importCsv', [Number(projectId), csv]);
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const pretty = argv.includes('--pretty');
  const filtered = argv.filter((a) => a !== '--pretty');
  const [cmd, ...rest] = filtered;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(`Usage:
  tgs status [--pretty]
  tgs methods [--pretty]
  tgs call <namespace.method> [jsonArg ...] [--pretty]
  tgs events [--seconds N]
  tgs projects [--pretty]
  tgs leads <projectId> [--min N] [--status new|replied|dialog|hidden|all] [--pretty]
  tgs sources <projectId> [--pretty]
  tgs import <projectId> <file.csv> [--pretty]`);
    process.exit(cmd ? 0 : 1);
  }

  const ctrl = loadControl();

  switch (cmd) {
    case 'status':
      await cmdStatus(ctrl, pretty);
      break;
    case 'methods': {
      const { data } = await request(ctrl, 'GET', '/api');
      printOut(data, pretty);
      break;
    }
    case 'call': {
      const [method, ...argStrs] = rest;
      if (!method) {
        console.error('usage: tgs call <namespace.method> [jsonArg ...]');
        process.exit(1);
      }
      const args = argStrs.map(parseArg);
      printOut(await apiCall(ctrl, method, args), pretty);
      break;
    }
    case 'events': {
      const sec = Number(hasFlag(rest, '--seconds') ?? '30');
      await cmdEvents(ctrl, sec);
      break;
    }
    case 'projects':
      printOut(await apiCall(ctrl, 'projects.list', []), pretty);
      break;
    case 'leads': {
      const [projectId, ...flags] = rest;
      if (!projectId) {
        console.error('usage: tgs leads <projectId> [--min N] [--status ...]');
        process.exit(1);
      }
      const filter = {};
      const min = hasFlag(flags, '--min');
      const status = hasFlag(flags, '--status');
      if (min !== undefined) filter.minScore = Number(min);
      if (status !== undefined) filter.status = status;
      printOut(await apiCall(ctrl, 'leads.list', [Number(projectId), filter]), pretty);
      break;
    }
    case 'sources': {
      const [projectId] = rest;
      if (!projectId) {
        console.error('usage: tgs sources <projectId>');
        process.exit(1);
      }
      printOut(await apiCall(ctrl, 'sources.list', [Number(projectId)]), pretty);
      break;
    }
    case 'import': {
      const [projectId, file] = rest.filter((x) => !x.startsWith('--'));
      if (!projectId || !file) {
        console.error('usage: tgs import <projectId> <file.csv>');
        process.exit(1);
      }
      printOut(await cmdImport(ctrl, projectId, file), pretty);
      break;
    }
    default:
      console.error(`Неизвестная команда: ${cmd}`);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});

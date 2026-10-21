import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startControlServer, pushControlEvent } from '../src/main/control';
import type { ControlHandlers } from '../src/main/control';

function fakeHandlers(): ControlHandlers {
  return {
    settings: {
      get: async () => ({
        tgApiId: '',
        tgApiHash: '',
        llmBaseUrl: '',
        llmApiKey: '',
        llmModel: '',
        jevBaseUrl: '',
        jevApiKey: '',
        jevModel: '',
        handoffNotifyTo: '',
      }),
      set: async (patch: Record<string, unknown>) => ({ ...(await fakeHandlers().settings.get()), ...patch }),
    },
    accounts: { list: async () => [], startLogin: async () => ({ accountId: 0, status: 'logged_out' }), submitCode: async () => ({ accountId: 0, status: 'logged_out' }), submitPassword: async () => ({ accountId: 0, status: 'logged_out' }), update: async () => fakeHandlers().accounts.list().then(() => ({ id: 1, phone: '', tgUserId: null, username: null, firstName: null, lastName: null, photoPath: null, status: 'authorized', dailyLimit: 10, pauseSec: 180, sentToday: 0, sentDay: null, lastSentAt: null, isPrimary: true })), remove: async () => {} },
    projects: { list: async () => [], create: async () => ({ id: 1, name: '', task: 'clients', target: '', offer: '', criteria: '', geo: [], languages: [], accountIds: [], materials: [], keywords: [], sequence: [], manager: { enabled: false, baseUrl: '', apiKey: '', model: '', prompt: '', replyDelaySec: 0, maxReplies: 0, voiceReplies: 'never' }, autopilot: { enabled: false, refreshSources: false, scanIntervalMin: 60, freshnessHours: 24, workingListSize: 10, aiReply: false, replyTarget: 'dm', replyInNewSources: false, joinIfNeeded: false, minScore: 80, lastRunAt: null, nextRunAt: null }, createdAt: 0 }), update: async () => fakeHandlers().projects.create({ name: 'x', task: 'clients', target: '', offer: '', criteria: '', geo: [], languages: [], accountIds: [], materials: [], keywords: [], sequence: [], manager: { enabled: false, baseUrl: '', apiKey: '', model: '', prompt: '', replyDelaySec: 0, maxReplies: 0, voiceReplies: 'never' } }), remove: async () => {}, suggestKeywords: async () => [] },
    sources: { list: async () => [], discover: async () => [], scan: async () => ({ checked: 0, newLeads: 0 }), add: async () => ({ id: 1, projectId: 1, tgChatId: 1, title: '', username: null, kind: 'group', memberCount: null, status: 'candidate', foundBy: null, accountId: null, checkedLeads: 0, matchedLeads: 0, lastScannedAt: null, lastMessageId: null, createdAt: 0 }), importCsv: async () => ({ added: 0, skipped: 0, failed: [] }), setStatus: async () => ({ id: 1, projectId: 1, tgChatId: 1, title: '', username: null, kind: 'group', memberCount: null, status: 'active', foundBy: null, accountId: null, checkedLeads: 0, matchedLeads: 0, lastScannedAt: null, lastMessageId: null, createdAt: 0 }) },
    leads: { list: async () => [], feedback: async () => ({ id: 1, projectId: 1, sourceId: null, tgChatId: 1, tgMessageId: 1, authorUserId: null, authorName: null, authorUsername: null, text: '', date: 0, link: null, score: 0, label: 'irrelevant', reason: '', feedback: null, status: 'new', accountId: null, sequenceStep: 0, nextStepAt: null, handoff: false, handoffReason: null, createdAt: 0 }), setStatus: async () => fakeHandlers().leads.feedback(1, null), setHandoff: async () => fakeHandlers().leads.feedback(1, null) },
    messages: { list: async () => [], draft: async () => '', send: async () => ({ id: 1, leadId: 1, accountId: null, direction: 'out', where: 'dm', text: '', tgChatId: 1, tgMessageId: null, date: 0, auto: false }) },
    agent: '',
    autopilot: { set: async () => fakeHandlers().projects.create({ name: 'x', task: 'clients', target: '', offer: '', criteria: '', geo: [], languages: [], accountIds: [], materials: [], keywords: [], sequence: [], manager: { enabled: false, baseUrl: '', apiKey: '', model: '', prompt: '', replyDelaySec: 0, maxReplies: 0, voiceReplies: 'never' } }), runNow: async () => {} },
    manager: { test: async () => ({ reply: '', handoff: false, reason: '' }) },
    broadcasts: { list: async () => [], create: async () => ({ id: 1, name: '', text: '', accountIds: [], chats: [], intervalHours: 24, spin: false, enabled: false, createdAt: 0 }), update: async () => fakeHandlers().broadcasts.create({ name: '', text: '', accountIds: [], chatLinks: [], intervalHours: 24, spin: false }), remove: async () => {}, runNow: async () => ({ posted: 0, skipped: 0, errors: 0 }) },
    shell: { openExternal: async () => {} },
  } as unknown as ControlHandlers; // only a few methods are called; the shapes are not under test here
}

describe('control server', () => {
  const servers: { stop(): void }[] = [];
  afterEach(() => {
    while (servers.length) servers.pop()!.stop();
  });

  it('returns 401 without token and accepts valid dispatch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgs-ctrl-'));
    const srv = await startControlServer({ handlers: fakeHandlers(), dataDir: dir, version: 'test' });
    servers.push(srv);

    const base = `http://127.0.0.1:${srv.port}`;
    const noAuth = await fetch(`${base}/health`);
    expect(noAuth.status).toBe(401);

    const bad = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer wrong' } });
    expect(bad.status).toBe(401);

    const controlPath = join(dir, 'control.json');
    expect(existsSync(controlPath)).toBe(true);
    if (process.platform !== 'win32') {
      const mode = statSync(controlPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const health = await fetch(`${base}/health`, { headers: { Authorization: `Bearer ${srv.token}` } });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 'test' });

    const call = await fetch(`${base}/api/settings.get`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: [] }),
    });
    expect(call.status).toBe(200);
    const body = await call.json();
    expect(body.ok).toBe(true);
    expect(body.result).toHaveProperty('tgApiId');

    servers.pop();
    srv.stop();
    expect(existsSync(controlPath)).toBe(false);
  });

  it('404 for unknown method and 400 on handler error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgs-ctrl-'));
    const handlers = fakeHandlers();
    handlers.settings.get = async () => {
      throw new Error('boom');
    };
    const srv = await startControlServer({ handlers, dataDir: dir, version: 'test' });
    servers.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;
    const auth = { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' };

    const unknown = await fetch(`${base}/api/nope.nope`, {
      method: 'POST',
      headers: auth,
      body: '{"args":[]}',
    });
    expect(unknown.status).toBe(404);

    const err = await fetch(`${base}/api/settings.get`, { method: 'POST', headers: auth, body: '{"args":[]}' });
    expect(err.status).toBe(400);
    expect((await err.json()).ok).toBe(false);
  });

  it('SSE delivers a pushed event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgs-ctrl-'));
    const srv = await startControlServer({ handlers: fakeHandlers(), dataDir: dir, version: 'test' });
    servers.push(srv);
    const base = `http://127.0.0.1:${srv.port}`;

    const eventPromise = new Promise<string>((resolve) => {
      void (async () => {
        const res = await fetch(`${base}/events`, { headers: { Authorization: `Bearer ${srv.token}` } });
        const reader = res.body!.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const m = buf.match(/data: (.+)\n\n/);
          if (m) resolve(m[1]);
        }
      })();
    });

    await new Promise((r) => setTimeout(r, 50));
    pushControlEvent({ type: 'job', projectId: 1, stage: 'scan', done: true });
    const line = await eventPromise;
    expect(JSON.parse(line)).toEqual({ type: 'job', projectId: 1, stage: 'scan', done: true });
  });
});

describe('tgs CLI', () => {
  it('calls settings.get via control file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgs-cli-'));
    const srv = await startControlServer({ handlers: fakeHandlers(), dataDir: dir, version: '0.1.0' });
    const cli = fileURLToPath(new URL('../bin/tgs.mjs', import.meta.url));

    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, 'call', 'settings.get'], {
        env: { ...process.env, TG_SEARCH_DATA: dir },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || stdout));
        else resolve(stdout);
      });
    });

    const parsed = JSON.parse(out.trim());
    expect(parsed).toHaveProperty('tgApiId');
    const meta = JSON.parse(readFileSync(join(dir, 'control.json'), 'utf8'));
    expect(meta.port).toBe(srv.port);
    srv.stop();
    rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createBridge } from '../src/main/opencode/bridge';
import type { AgentDef } from '../src/shared/types';
import { listAgentSteps } from '../src/main/agent/store';
import { ensureAgentSchema } from '../src/main/agent/schema';

const agent = { name: 'manager', description: '', mode: 'primary', model: 'main', temperature: 0.3, steps: 8, prompt: '', permission: { send_asset: 'deny' } } as unknown as AgentDef;

describe('opencode bridge', () => {
  it('serves the tool list, runs a bound call, refuses unknown sessions and denied tools', async () => {
    const db = new Db(':memory:');
    ensureAgentSchema(db.raw, db);
    const bridge = createBridge({
      db, emit: () => {}, agents: () => ({}) as never, approvals: () => undefined,
      catalog: () => [{ name: 'tgs_reply', description: 'reply', input: { type: 'object' } }],
    });
    const url = await bridge.start();
    const post = (body: unknown, token = bridge.token()) => fetch(`${url}/call`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect((await fetch(`${url}/tools`)).status).toBe(401);
    expect((await (await fetch(`${url}/tools`, { headers: { Authorization: `Bearer ${bridge.token()}` } })).json()).tools[0].name).toBe('tgs_reply');

    expect((await (await post({ tool: 'tgs_reply', input: { text: 'ок' }, sessionID: 'ses_x' })).json()).content).toMatch(/не ведётся/);

    const seen: unknown[] = [];
    bridge.bind('ses_1', {
      ctx: { leadId: 7, clientId: null, dryRun: false }, agentName: 'manager', agent,
      tools: [
        { name: 'reply', description: '', parameters: {}, run: async (args) => (seen.push(args), 'Сообщение отправлено') },
        { name: 'send_asset', description: '', parameters: {}, run: async () => 'нельзя' },
      ],
    });
    expect((await (await post({ tool: 'tgs_reply', input: { text: 'ок' }, sessionID: 'ses_1' })).json()).content).toBe('Сообщение отправлено');
    expect(seen).toEqual([{ text: 'ок' }]);
    expect((await (await post({ tool: 'tgs_send_asset', input: {}, sessionID: 'ses_1' })).json()).content).toMatch(/недоступен/);
    expect(listAgentSteps(db, 7).map((s) => [s.tool, s.ok])).toEqual([['send_asset', false], ['reply', true]]);

    bridge.unbind('ses_1');
    expect((await (await post({ tool: 'tgs_reply', input: {}, sessionID: 'ses_1' })).json()).content).toMatch(/не ведётся/);
    await bridge.stop();
  });
});

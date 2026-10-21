// The app side of the OpenCode plugin: a localhost HTTP endpoint with a bearer token. The plugin asks for the tool
// list once and forwards every call with the OpenCode session id; the app knows which dialog (lead) a session
// belongs to, checks the agent's permissions and owner approvals, runs the existing tool and records the step.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AgentDef, AppEvent } from '../../shared/types';
import type { Db } from '../db';
import type { AgentTool, ToolContext } from '../agent/types';
import type { AgentDefsApi } from '../agent/defs';
import type { ApprovalsApi } from '../agent/approvals';
import { gateToolCall } from '../agent/approvals';
import { resolveToolPermission } from '../agent/permissions';
import { insertAgentStep } from '../agent/store';
import { TOOL_PREFIX } from './config';

// What a session is doing right now: set before a prompt, cleared when the turn ends
export interface SessionBinding {
  ctx: ToolContext;
  tools: AgentTool[]; // built for this turn's host (turn state, task dir…)
  agentName: string; // our agent (manager, researcher…), for permissions and the trace
  agent: AgentDef;
  stepPrefix?: string; // «researcher:» for subagents in the trace
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

export function createBridge(deps: {
  db: Db;
  emit: (e: AppEvent) => void;
  agents: () => AgentDefsApi;
  approvals: () => ApprovalsApi | undefined;
  catalog: () => ToolCatalogEntry[]; // every app tool the agents may get (prefixed names)
}) {
  const token = randomBytes(24).toString('base64url');
  const bindings = new Map<string, SessionBinding>();
  let server: Server | null = null;
  let url = '';

  async function readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  }

  async function call(body: { tool: string; input: Record<string, unknown>; sessionID: string }): Promise<string> {
    const binding = bindings.get(body.sessionID);
    if (!binding) return 'Ошибка: этот разговор сейчас не ведётся приложением';
    const name = body.tool.startsWith(TOOL_PREFIX) ? body.tool.slice(TOOL_PREFIX.length) : body.tool;
    const tool = binding.tools.find((t) => t.name === name);
    let output: string;
    let ok = false;
    if (!tool || resolveToolPermission(binding.agent.permission, name) === 'deny') {
      output = 'Ошибка: инструмент недоступен этому агенту';
    } else {
      const approvals = deps.approvals();
      const gate = approvals
        ? gateToolCall(binding.agentName, binding.agent, name, body.input, binding.ctx, { db: deps.db, agents: deps.agents(), approvals })
        : { blocked: false as const };
      if (gate.blocked) {
        output = gate.output;
        ok = gate.ok;
      } else {
        try {
          output = await tool.run(body.input ?? {}, binding.ctx);
          ok = !output.startsWith('Ошибка');
        } catch (e) {
          output = `Ошибка: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
    }
    const step = insertAgentStep(deps.db, {
      leadId: binding.ctx.leadId, ts: Date.now(), tool: `${binding.stepPrefix ?? ''}${name}`,
      input: JSON.stringify(body.input ?? {}), output, ok,
    });
    deps.emit({ type: 'agent:step', step });
    return output;
  }

  return {
    token: () => token,
    url: () => url,
    bind(sessionID: string, binding: SessionBinding) {
      bindings.set(sessionID, binding);
    },
    unbind(sessionID: string) {
      bindings.delete(sessionID);
    },
    call, // exported for tests

    async start(): Promise<string> {
      server = createServer((req, res) => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(data));
        };
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
        if (req.method === 'GET' && req.url === '/tools') return send(200, { tools: deps.catalog() });
        if (req.method === 'POST' && req.url === '/call') {
          readJson(req)
            .then((body) => call(body))
            .then((content) => send(200, { content }), (e) => send(500, { error: String(e) }));
          return;
        }
        send(404, { error: 'not found' });
      });
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      return url;
    },

    async stop() {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      server = null;
    },
  };
}

export type Bridge = ReturnType<typeof createBridge>;

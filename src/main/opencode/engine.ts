// The AI engine: the app's own OpenCode v2 server with our agents, providers and the tool bridge. All model work in
// the app goes through it — agent turns as OpenCode sessions (one persistent session per dialog), everything else
// through the gateway's one-shot sessions.
import { join } from 'node:path';
import type { AppEvent, Settings } from '../../shared/types';
import type { Db } from '../db';
import type { AgentDefsApi } from '../agent/defs';
import type { ApprovalsApi } from '../agent/approvals';
import { resolveToolPermission } from '../agent/permissions';
import { CHAT_STYLE, HONESTY_RULE, RICH_FORMAT } from '../agent/style';
import { gatewayPrompt, setLlmGateway, type LlmGateway } from '../ai/gateway';
import { recordUsage } from '../usage';
import { createBridge, type SessionBinding, type ToolCatalogEntry } from './bridge';
import { TOOL_PREFIX, writeOpencodeConfig, type AgentConfig, type ProviderConfig } from './config';
import { importFromUserOpencode, mergeProviders, providersFromSettings } from './importProviders';
import { pickModel, rankModels, refString, toCatalog, type CatalogModel, type ModelRole } from './models';
import { createOpencodeRuntime } from './runtime';
import { createOpencodeServer, type OpencodeStatus } from './server';
import { createSessions, ONESHOT_AGENT, type ModelRef, type TurnResult } from './session';

export const UPDATE_CHECK_MS = 24 * 3600_000;
const MAX_ATTEMPTS = 4; // models tried for one job before giving up
// a model that failed rests: a rate limit (free models: ~20 a minute, a daily cap) longer than a one-off error
const cooldownMs = (error: string) => (/429|rate|limit|quota|exhaust|too many/i.test(error) ? 30 * 60_000 : 10 * 60_000);

// Our agent (manager, researcher…) → the OpenCode agent id
export const ocAgentId = (name: string) => `tgs-${name}`;

// What an agent definition's «model» field means now: a role the router fills from the chosen models
export function agentRole(model: string): ModelRole {
  const m = model.trim();
  if (m === 'main' || m === 'glm' || m === '') return 'chat';
  if (m === 'vision' || m === 'gemini') return 'vision';
  if (m === 'smart' || m === 'deepseek') return 'smart';
  return 'fast';
}

export function createAiEngine(deps: {
  root: string; // userData/opencode
  db: Db;
  emit: (e: AppEvent) => void;
  getSettings: () => Settings;
  setSettings: (patch: Partial<Settings>) => void;
  agents: () => AgentDefsApi;
  approvals: () => ApprovalsApi | undefined;
  toolCatalog: () => ToolCatalogEntry[];
}) {
  deps.db.raw.exec(`CREATE TABLE IF NOT EXISTS opencode_sessions (
    key TEXT PRIMARY KEY, -- 'lead:<id>' for a dialog, 'task:<id>' for a background task
    session_id TEXT NOT NULL,
    synced_message_id INTEGER NOT NULL DEFAULT 0, -- our messages already shown to the session
    created_at INTEGER NOT NULL
  )`);
  const runtime = createOpencodeRuntime(deps.root);
  const configDir = join(deps.root, 'config');
  const bridge = createBridge({ db: deps.db, emit: deps.emit, agents: deps.agents, approvals: deps.approvals, catalog: deps.toolCatalog });
  let catalog: CatalogModel[] = [];
  const server = createOpencodeServer({
    root: deps.root,
    runtime,
    configDir: () => configDir,
    extraEnv: () => ({ TGS_BRIDGE_URL: bridge.url(), TGS_BRIDGE_TOKEN: bridge.token() }),
    onStatus: (s) => deps.emit({ type: 'ai:status', status: s }),
  });
  const sessions = createSessions(server, bridge);

  function providers(): ProviderConfig[] {
    try {
      const list = JSON.parse(deps.getSettings().aiProviders || '[]') as ProviderConfig[];
      if (list.length) return list;
    } catch {
      /* first start */
    }
    // first start: the keys the app already has plus the user's own OpenCode
    const migrated = mergeProviders(providersFromSettings(deps.getSettings()), safeImport());
    deps.setSettings({ aiProviders: JSON.stringify(migrated) });
    return migrated;
  }

  function safeImport(): ProviderConfig[] {
    try {
      return importFromUserOpencode();
    } catch (err) {
      console.error('opencode import', err);
      return [];
    }
  }

  function agentConfigs(): AgentConfig[] {
    const defs = deps.agents();
    const rules = defs.rules();
    const owner = deps.getSettings().ownerName || 'владельца';
    const toolNames = deps.toolCatalog().map((t) => t.name.slice(TOOL_PREFIX.length));
    const list: AgentConfig[] = [{
      id: ONESHOT_AGENT, description: 'Один запрос без инструментов', mode: 'primary', tools: [], // no step cap: a cap makes OpenCode tell the model «max steps reached»
      system: 'Выполни запрос строго по инструкции в сообщении. Отвечай по-русски, если не сказано иначе.',
    }];
    for (const a of defs.list()) {
      const primary = a.mode === 'primary';
      list.push({
        id: ocAgentId(a.name),
        description: a.description,
        mode: primary ? 'primary' : 'subagent',
        steps: a.steps,
        // every agent's text can reach the client (subagent results are delivered as is), so all of them know the format
        system: [rules, primary ? CHAT_STYLE : '', RICH_FORMAT, primary ? HONESTY_RULE.replaceAll('{owner}', owner) : '', a.prompt].filter(Boolean).join('\n\n'),
        tools: toolNames.filter((t) => resolveToolPermission(a.permission, t) !== 'deny'),
      });
    }
    return list;
  }

  function writeConfig() {
    writeOpencodeConfig(configDir, providers(), agentConfigs());
  }

  async function refreshCatalog(): Promise<CatalogModel[]> {
    const res = await server.call<{ data: any[] }>('GET', '/api/model');
    catalog = toCatalog(res.data, new Set(providers().map((p) => p.id)));
    ensureChoice();
    return catalog;
  }

  // A sensible default the first time: the strongest chat model with tools as main, a vision one and a fast one as helpers
  function ensureChoice() {
    const s = deps.getSettings();
    const refs = new Set(catalog.map(refString));
    if (s.aiMainModel && refs.has(s.aiMainModel)) return;
    const prefer = [/glm-5\.3-flash$/, /claude-sonnet/, /gemini-3\.8-flash/, /deepseek/];
    const tools = catalog.filter((m) => m.tools && m.enabled);
    const main = prefer.map((re) => tools.find((m) => re.test(m.id))).find(Boolean) ?? tools[0];
    if (!main) return;
    const vision = tools.find((m) => m.vision && /gemini/.test(m.id)) ?? tools.find((m) => m.vision && m !== main);
    const smart = tools.find((m) => /claude-sonnet|deepseek-v4-pro|gpt-6-sol/.test(m.id) && m !== main);
    const helpers = [vision, smart].filter((m): m is CatalogModel => !!m).map(refString);
    deps.setSettings({ aiMainModel: refString(main), aiHelperModels: JSON.stringify([...new Set(helpers)]) });
  }

  function choice() {
    const s = deps.getSettings();
    let helpers: string[] = [];
    try {
      helpers = JSON.parse(s.aiHelperModels || '[]');
    } catch {
      helpers = [];
    }
    return { main: s.aiMainModel, helpers, useFree: s.aiUseFree !== '0' };
  }

  const cooling = new Map<string, number>(); // model ref → resting until
  const routeOpts = () => ({ useFree: choice().useFree, cooling: (ref: string) => (cooling.get(ref) ?? 0) > Date.now() });
  const refOf = (m: ModelRef) => `${m.providerID}/${m.id}`;
  function failed(m: ModelRef, error: string) {
    cooling.set(refOf(m), Date.now() + cooldownMs(error));
    console.warn(`model ${refOf(m)} failed, trying the next one: ${error.slice(0, 200)}`);
  }

  function model(role: ModelRole, need: { tools?: boolean; vision?: boolean } = {}): ModelRef {
    return pickModel(catalog, choice(), role, need, routeOpts());
  }

  // the models to try for a job, best first; at least the one pickModel would give (or its error)
  function candidates(role: ModelRole, need: { tools?: boolean; vision?: boolean }): ModelRef[] {
    const list = rankModels(catalog, choice(), role, need, routeOpts()).slice(0, MAX_ATTEMPTS);
    return list.length ? list : [model(role, need)];
  }

  const gateway: LlmGateway = {
    async complete(req) {
      // no silent fallback to a provider's API: until OpenCode is up, model requests fail with the reason
      if (server.status().state !== 'ready') throw new Error(`ИИ-движок OpenCode не запущен: ${server.status().message ?? server.status().state}`);
      let lastError: unknown;
      for (const m of candidates(req.role, { vision: !!req.images?.length })) {
        try {
          const text = await sessions.oneShot({ model: m, text: gatewayPrompt(req), files: req.images, title: req.title });
          recordUsage({ kind: 'llm', model: refOf(m) });
          return text;
        } catch (err) {
          lastError = err;
          failed(m, err instanceof Error ? err.message : String(err));
        }
      }
      throw lastError;
    },
  };

  // An agent turn in the dialog's persistent session (dry runs get a throwaway one). A failed model hands the turn to
  // the next candidate in the same session, unless the turn already did something visible (canRetry).
  async function agentTurn(opts: {
    key: string | null; // 'lead:<id>' / 'task:<id>'; null — throwaway session
    agentName: string;
    role: ModelRole;
    prompt: (synced: number) => { text: string; lastMessageId: number }; // new dialog part since `synced`
    files?: string[];
    binding: SessionBinding;
    timeoutMs?: number;
    parentKey?: string;
    requireText?: boolean; // the turn's text is the result (subagents): an empty one counts as a failure
    canRetry?: () => boolean;
  }): Promise<TurnResult & { model: string }> {
    const models = candidates(opts.role, { tools: true, vision: !!opts.files?.length });
    const row = opts.key
      ? deps.db.raw.prepare('SELECT session_id, synced_message_id FROM opencode_sessions WHERE key = ?').get(opts.key) as { session_id: string; synced_message_id: number } | undefined
      : undefined;
    let sessionID = row?.session_id;
    if (!sessionID) {
      const parent = opts.parentKey
        ? (deps.db.raw.prepare('SELECT session_id FROM opencode_sessions WHERE key = ?').get(opts.parentKey) as { session_id: string } | undefined)?.session_id
        : undefined;
      sessionID = await sessions.create({ agent: ocAgentId(opts.agentName), model: models[0], title: opts.key ?? 'sandbox', parentID: parent });
      if (opts.key) deps.db.raw.prepare('INSERT OR REPLACE INTO opencode_sessions(key, session_id, created_at) VALUES(?, ?, ?)').run(opts.key, sessionID, Date.now());
    }
    const { text, lastMessageId } = opts.prompt(row?.synced_message_id ?? 0);
    try {
      let result: TurnResult = { outcome: 'failed', text: '', error: 'нет модели', costUsd: 0 };
      for (const [i, m] of models.entries()) {
        if (i > 0 || row) await sessions.setModel(sessionID, m); // the owner may have switched models since the last turn
        result = await sessions.runTurn(sessionID, { text, files: opts.files }, opts.binding, opts.timeoutMs);
        recordUsage({ kind: 'llm', model: refOf(m), costUsd: result.costUsd });
        const ok = result.outcome === 'succeeded' && (!opts.requireText || !!result.text.trim());
        if (ok) {
          if (opts.key) deps.db.raw.prepare('UPDATE opencode_sessions SET synced_message_id = ? WHERE key = ?').run(lastMessageId, opts.key);
          return { ...result, model: refOf(m) };
        }
        if (result.outcome === 'interrupted') break;
        failed(m, result.error ?? (result.outcome === 'succeeded' ? 'пустой ответ' : result.outcome));
        if (opts.canRetry && !opts.canRetry()) break;
      }
      return { ...result, model: '' };
    } finally {
      if (!opts.key) void sessions.remove(sessionID);
    }
  }

  let updateTimer: ReturnType<typeof setInterval> | null = null;

  return {
    status: (): OpencodeStatus => server.status(),
    catalog: () => catalog,
    choice,
    model,
    agentTurn,
    bridge,

    async start() {
      setLlmGateway(gateway);
      await bridge.start();
      writeConfig();
      await server.start();
      await refreshCatalog();
      updateTimer = setInterval(() => void this.update().catch((e) => console.error('opencode update', e)), UPDATE_CHECK_MS);
      updateTimer.unref?.();
      setTimeout(() => void this.update().catch((e) => console.error('opencode update', e)), 5 * 60_000).unref?.();
    },

    async stop() {
      if (updateTimer) clearInterval(updateTimer);
      setLlmGateway(null);
      await server.stop();
      await bridge.stop();
    },

    async update(): Promise<string> {
      const msg = await server.update();
      await refreshCatalog();
      return msg;
    },

    // Providers or agents changed: rewrite the config; OpenCode reloads it, the catalog follows
    async reconfigure() {
      writeConfig();
      await new Promise((r) => setTimeout(r, 1500));
      await refreshCatalog().catch(() => {});
    },

    async importUserOpencode(): Promise<number> {
      const imported = safeImport();
      deps.setSettings({ aiProviders: JSON.stringify(mergeProviders(providers(), imported)) });
      await this.reconfigure();
      return imported.length;
    },

    refreshCatalog,
  };
}

export type AiEngine = ReturnType<typeof createAiEngine>;

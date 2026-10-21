// The AI engine: the app's own OpenCode v2 server with our agents, providers and the tool bridge. All model work in
// the app goes through it — agent turns as OpenCode sessions (one persistent session per dialog), everything else
// through the gateway's one-shot sessions.
import { join } from 'node:path';
import type { AiRoute, AppEvent, Settings } from '../../shared/types';
import type { Db } from '../db';
import type { AgentDefsApi } from '../agent/defs';
import type { ApprovalsApi } from '../agent/approvals';
import { resolveToolPermission } from '../agent/permissions';
import { CHAT_STYLE, HONESTY_RULE, RICH_FORMAT } from '../agent/style';
import { FIGURES_GUIDE } from '../figures';
import { gatewayPrompt, setLlmGateway, type LlmGateway } from '../ai/gateway';
import { recordUsage } from '../usage';
import { createBridge, type SessionBinding, type ToolCatalogEntry } from './bridge';
import { TOOL_PREFIX, writeOpencodeConfig, type AgentConfig, type ProviderConfig } from './config';
import { importFromUserOpencode, mergeProviders, providersFromSettings } from './importProviders';
import { isFreeModel, isSubscriptionModel, pickModel, poolModels, rankModels, ROLE_NEEDS, refString, toCatalog, type CatalogModel, type ModelRole } from './models';
import { jevRankModels } from './jevRoute';
import { createLedger, currentJob, type RunOutcome } from './ledger';
import { parseVerdict, verifyPrompt, type Verdict, type VerifyMode } from './verify';
import { createProfiles, fetchOpenRouterMeta, fromOpenRouter, matchOpenRouter, SKILL_LABELS, SKILLS, type ProfileInput, type Skill } from './profiles';
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
  const profiles = createProfiles(deps.db);
  const ledger = createLedger(deps.db);

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
        system: [rules, primary ? CHAT_STYLE : '', RICH_FORMAT, primary ? '' : FIGURES_GUIDE, primary ? HONESTY_RULE.replaceAll('{owner}', owner) : '', a.prompt].filter(Boolean).join('\n\n'),
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
  const routeOpts = (needs?: Skill[]) => ({
    useFree: choice().useFree, needs, profile: profiles.get,
    cooling: (ref: string) => (cooling.get(ref) ?? 0) > Date.now(),
  });
  const refOf = (m: ModelRef) => `${m.providerID}/${m.id}`;
  function failed(m: ModelRef, error: string) {
    cooling.set(refOf(m), Date.now() + cooldownMs(error));
    console.warn(`model ${refOf(m)} failed, trying the next one: ${error.slice(0, 200)}`);
  }

  function model(role: ModelRole, need: { tools?: boolean; vision?: boolean } = {}): ModelRef {
    return pickModel(catalog, choice(), role, need, routeOpts());
  }

  // the models to try for a job, best first; at least the one pickModel would give (or its error)
  // What Jev reads about a model: its original description and the facts that matter for a job
  function modelText(m: CatalogModel): string {
    const about = profiles.get(refString(m))?.about?.trim();
    return [
      `${m.name}${about ? ` — ${about}` : ''}`,
      `Facts: ${isFreeModel(m) ? 'free' : 'subscription'}; understands images: ${m.vision ? 'yes' : 'no'}; ` +
        `reasoning levels: ${m.variants.join(', ') || 'none'}; context: ${m.context} tokens.`,
    ].join('\n');
  }

  // The models to try for a job, best first. With the task text, Jev picks the order of the first line (subscriptions
  // and free models) by their descriptions; without Jev — by their profiles.
  // The models to try for a job, best first: Jev's fit for this very task times the model's track record with this kind
  // of job (ledger: done, turned down by the verifier, sent back by the agent, corrected by the client)
  async function candidates(role: ModelRole, need: { tools?: boolean; vision?: boolean }, needs?: Skill[], task?: string, agent = 'gateway'): Promise<ModelRef[]> {
    const opts = routeOpts(needs);
    const pool = poolModels(catalog, choice(), role, need, opts).slice(0, 10);
    let fit = new Map(pool.map((m, i) => [refString(m), 1 / (i + 2)])); // the profiles' order when Jev is not asked
    if (task && pool.length > 1 && deps.getSettings().jevApiKey.trim()) {
      try {
        const ranked = await jevRankModels(deps.getSettings, task, needs?.length ? needs : ROLE_NEEDS[role], pool.map((m) => ({ ref: refString(m), text: modelText(m) })));
        fit = new Map(ranked.map((r) => [r.ref, r.p]));
      } catch (err) {
        console.warn('jev route', err);
      }
    }
    const trust = ledger.reliability(agent);
    const score = (ref: string) => (fit.get(ref) ?? 0) * 2 * (trust.get(ref) ?? 0.5); // 0.5 = no history: neutral
    const poolOrder = [...fit.keys()].sort((a, b) => score(b) - score(a));
    if (pool.length) {
      console.log(`route ${agent} (${role}): ${poolOrder.slice(0, 3).map((r) => `${r} fit ${(fit.get(r) ?? 0).toFixed(2)} trust ${(trust.get(r) ?? 0.5).toFixed(2)}`).join(' | ')}`);
    }
    const list = rankModels(catalog, choice(), role, need, { ...opts, poolOrder }).slice(0, MAX_ATTEMPTS);
    return list.length ? list : [model(role, need)];
  }

  const gateway: LlmGateway = {
    async complete(req) {
      // no silent fallback to a provider's API: until OpenCode is up, model requests fail with the reason
      if (server.status().state !== 'ready') throw new Error(`ИИ-движок OpenCode не запущен: ${server.status().message ?? server.status().state}`);
      let lastError: unknown;
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')?.text ?? '';
      const task = [req.title, req.system?.slice(0, 500), lastUser.slice(0, 1500)].filter(Boolean).join('\n');
      const job = currentJob();
      const agent = job?.agent ?? 'gateway';
      for (const m of await candidates(req.role, { vision: !!req.images?.length }, undefined, task, agent)) {
        const started = Date.now();
        try {
          const text = await sessions.oneShot({ model: m, text: gatewayPrompt(req), files: req.images, title: req.title });
          recordUsage({ kind: 'llm', model: refOf(m) });
          if (req.role !== 'chat') ledger.record({ model: refOf(m), agent, outcome: 'ok', task: lastUser, ms: Date.now() - started, ...job });
          return text;
        } catch (err) {
          lastError = err;
          const error = err instanceof Error ? err.message : String(err);
          if (req.role !== 'chat') ledger.record({ model: refOf(m), agent, outcome: /пустой/.test(error) ? 'empty' : 'error', error, task: lastUser, ms: Date.now() - started, ...job });
          failed(m, error);
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
    taskId?: number; // a background task: its runs are reviewed later by the primary agent
    verify?: { task: string; images?: string[] }; // check the result with a second model (by the agent's `verify` mode)
    model?: string; // provider/model to try first (a group's choice); the router's candidates follow
    verifyMode?: VerifyMode; // instead of the agent's own `verify`
    verifier?: string; // provider/model of the checker
  }): Promise<TurnResult & { model: string; score?: number }> {
    const row = opts.key
      ? deps.db.raw.prepare('SELECT session_id, synced_message_id FROM opencode_sessions WHERE key = ?').get(opts.key) as { session_id: string; synced_message_id: number } | undefined
      : undefined;
    const { text, lastMessageId } = opts.prompt(row?.synced_message_id ?? 0);
    const routed = await candidates(opts.role, { tools: true, vision: !!opts.files?.length }, agentNeeds(opts.agentName), text, opts.agentName);
    const models = withPreferred(opts.model, routed);
    const own = agentPolicy(opts.agentName);
    const policy = { mode: opts.verifyMode ?? own.mode, check: own.check };
    const leadId = opts.binding.ctx.leadId || undefined;
    let sessionID = row?.session_id;
    if (!sessionID) {
      const parent = opts.parentKey
        ? (deps.db.raw.prepare('SELECT session_id FROM opencode_sessions WHERE key = ?').get(opts.parentKey) as { session_id: string } | undefined)?.session_id
        : undefined;
      sessionID = await sessions.create({ agent: ocAgentId(opts.agentName), model: models[0], title: opts.key ?? 'sandbox', parentID: parent });
      if (opts.key) deps.db.raw.prepare('INSERT OR REPLACE INTO opencode_sessions(key, session_id, created_at) VALUES(?, ?, ?)').run(opts.key, sessionID, Date.now());
    }
    try {
      let result: TurnResult = { outcome: 'failed', text: '', error: 'нет модели', costUsd: 0 };
      let best: (TurnResult & { model: string; score?: number }) | null = null; // every model turned down: the best of them
      let prompt = text;
      for (const [i, m] of models.entries()) {
        if (i > 0 || row) await sessions.setModel(sessionID, m); // the owner may have switched models since the last turn
        const started = Date.now();
        result = await sessions.runTurn(sessionID, { text: prompt, files: opts.files }, opts.binding, opts.timeoutMs);
        recordUsage({ kind: 'llm', model: refOf(m), costUsd: result.costUsd });
        const ok = result.outcome === 'succeeded' && (!opts.requireText || !!result.text.trim());
        const track = opts.role !== 'chat'; // client chat is the main model's, not a routed job
        const outcome: RunOutcome = ok ? 'ok' : result.outcome === 'timeout' ? 'timeout' : result.outcome === 'succeeded' ? 'empty' : 'error';
        const runId = track ? ledger.record({
          model: refOf(m), agent: opts.agentName, outcome, error: result.error, task: opts.verify?.task ?? text, ms: Date.now() - started,
          cost: result.costUsd, leadId, taskId: opts.taskId,
        }) : 0;
        if (ok) {
          const verdict = opts.verify && shouldVerify(policy.mode, m) ? await verifyWith(m, { ...opts.verify, verifier: opts.verifier }, result.text, policy.check).catch((err) => {
            console.warn('verify', err);
            return null;
          }) : null;
          if (verdict && runId) ledger.verdict(runId, { ...verdict, verifier: verdict.verifier });
          if (!verdict || verdict.ok || !(opts.canRetry?.() ?? true) || i === models.length - 1) {
            if (opts.key) deps.db.raw.prepare('UPDATE opencode_sessions SET synced_message_id = ? WHERE key = ?').run(lastMessageId, opts.key);
            const done = { ...result, model: refOf(m), score: verdict?.score };
            if (!verdict || verdict.ok || !best || (best.score ?? 0) < verdict.score) return done;
            return best;
          }
          // turned down: the next model sees the previous answer in the session and the verifier's notes
          console.warn(`verify: ${refOf(m)} scored ${verdict.score.toFixed(2)} on ${opts.agentName} — ${verdict.note.slice(0, 200)}`);
          if (!best || (best.score ?? 0) < verdict.score) best = { ...result, model: refOf(m), score: verdict.score };
          prompt = `Проверяющий отклонил предыдущий ответ: ${verdict.note || 'есть ошибки по существу'}\n\nСделай задачу заново полностью, исправив это. Исходное поручение — выше.`;
          continue;
        }
        if (result.outcome === 'interrupted') break;
        failed(m, result.error ?? (result.outcome === 'succeeded' ? 'пустой ответ' : result.outcome));
        if (opts.canRetry && !opts.canRetry()) break;
      }
      if (best) {
        if (opts.key) deps.db.raw.prepare('UPDATE opencode_sessions SET synced_message_id = ? WHERE key = ?').run(lastMessageId, opts.key);
        return best;
      }
      return { ...result, model: '' };
    } finally {
      if (!opts.key) void sessions.remove(sessionID);
    }
  }

  function agentPolicy(name: string): { mode: VerifyMode; check: string } {
    try {
      const a = deps.agents().get(name);
      return { mode: a.verify, check: a.check };
    } catch {
      return { mode: 'off', check: '' };
    }
  }

  // a chosen model first, then the router's candidates without it
  function withPreferred(ref: string | undefined, routed: ModelRef[]): ModelRef[] {
    const m = ref ? catalog.find((x) => refString(x) === ref) : undefined;
    if (!m) return routed;
    const first: ModelRef = { providerID: m.providerID, id: m.id, variant: m.variants.includes('medium') ? 'medium' : undefined };
    return [first, ...routed.filter((r) => refOf(r) !== ref)].slice(0, MAX_ATTEMPTS);
  }

  // One request straight to a model (no agent, no tools): the text goes out as is. Checked by a second model when the
  // mode says so; a turned-down answer goes to the next model with the checker's notes.
  async function direct(opts: {
    agent: string; // for the ledger: what kind of job
    role: ModelRole;
    model?: string;
    system?: string;
    context?: string; // the job's materials (group, knowledge passages): in the prompt and in front of the checker
    text: string;
    images?: string[];
    verifyMode?: VerifyMode;
    verifier?: string;
    check?: string;
  }): Promise<{ text: string; model: string; score?: number }> {
    if (server.status().state !== 'ready') throw new Error(`ИИ-движок OpenCode не запущен: ${server.status().message ?? server.status().state}`);
    const models = withPreferred(opts.model, await candidates(opts.role, { vision: !!opts.images?.length }, undefined, opts.text, opts.agent));
    const base = [opts.system, opts.context, opts.text].filter(Boolean).join('\n\n');
    let prompt = base;
    const checkTask = [opts.text, opts.context && `Материалы и контекст:\n${opts.context}`].filter(Boolean).join('\n\n');
    let best: { text: string; model: string; score?: number } | null = null;
    let lastError: unknown = null;
    for (const m of models) {
      const started = Date.now();
      try {
        const text = await sessions.oneShot({ model: m, text: prompt, files: opts.images, title: opts.agent, timeoutMs: 5 * 60_000 });
        recordUsage({ kind: 'llm', model: refOf(m) });
        const runId = ledger.record({ model: refOf(m), agent: opts.agent, outcome: 'ok', task: opts.text, ms: Date.now() - started });
        const verdict = shouldVerify(opts.verifyMode ?? 'off', m)
          ? await verifyWith(m, { task: checkTask, images: opts.images, verifier: opts.verifier }, text, opts.check ?? '').catch(() => null)
          : null;
        if (verdict) ledger.verdict(runId, verdict);
        if (!verdict || verdict.ok) return { text, model: refOf(m), score: verdict?.score };
        if (!best || (best.score ?? 0) < verdict.score) best = { text, model: refOf(m), score: verdict.score };
        prompt = `${base}\n\nПредыдущий ответ другой модели проверяющий отклонил: ${verdict.note || 'есть ошибки по существу'}\n<rejected>\n${text.slice(0, 8000)}\n</rejected>\nСделай заново, исправив это.`;
      } catch (err) {
        lastError = err;
        const error = err instanceof Error ? err.message : String(err);
        ledger.record({ model: refOf(m), agent: opts.agent, outcome: /пустой/.test(error) ? 'empty' : 'error', error, task: opts.text, ms: Date.now() - started });
        failed(m, error);
      }
    }
    if (best) return best;
    throw lastError ?? new Error('нет подходящей модели');
  }

  const shouldVerify = (mode: VerifyMode, m: ModelRef) => mode === 'always' || (mode === 'free' && isFreeModel(m));

  // The verifier: the owner's choice in Settings, else a strong ticked subscription (Gemini 3.8 Flash High if ticked);
  // never the model that did the work; one that sees images when the job has them
  function verifiersFor(producer: ModelRef, vision: boolean, prefer?: string): ModelRef[] {
    const byRef = new Map(catalog.map((m) => [refString(m), m]));
    const usable = (ref: string) => {
      const m = byRef.get(ref);
      return m && m.enabled && ref !== refOf(producer) && (!vision || m.vision) ? m : null;
    };
    const c = choice();
    const preferred = [prefer, deps.getSettings().aiVerifierModel, ...c.helpers.filter((r) => /gemini-3\.8-flash-high/.test(r))].filter((r): r is string => !!r);
    const ticked = [...c.helpers, c.main].map(usable).filter((m): m is CatalogModel => !!m)
      .sort((a, b) => Number(isSubscriptionModel(b)) - Number(isSubscriptionModel(a)) || (b.costIn + b.costOut) - (a.costIn + a.costOut));
    // medium reasoning: at «high» a model may spend the whole output on thinking and answer nothing
    const list = [...preferred.map(usable).filter((m): m is CatalogModel => !!m), ...ticked];
    return [...new Map(list.map((m) => [refString(m), m])).values()].slice(0, 2)
      .map((m) => ({ providerID: m.providerID, id: m.id, variant: m.variants.includes('medium') ? 'medium' : undefined }));
  }

  async function verifyWith(producer: ModelRef, job: { task: string; images?: string[]; verifier?: string }, result: string, check: string): Promise<(Verdict & { verifier: string }) | null> {
    let lastError: unknown = null;
    for (const v of verifiersFor(producer, !!job.images?.length, job.verifier)) {
      try {
        const raw = await sessions.oneShot({ model: v, text: verifyPrompt(job.task, result, check), files: job.images, title: 'verify' });
        recordUsage({ kind: 'llm', model: refOf(v) });
        return { ...parseVerdict(raw), verifier: refOf(v) };
      } catch (err) {
        lastError = err; // the next verifier
        failed(v, err instanceof Error ? err.message : String(err));
      }
    }
    if (lastError) throw lastError;
    return null;
  }

  function agentNeeds(name: string): Skill[] | undefined {
    try {
      return deps.agents().get(name).needs.filter((n): n is Skill => (SKILLS as string[]).includes(n));
    } catch {
      return undefined;
    }
  }

  // What the free, subscription and ticked models are good at, from OpenRouter's descriptions (a subscription model
  // borrows the description of the same model there); only new or changed ones are scored, by the main model
  async function refreshProfiles(): Promise<number> {
    const metas = await fetchOpenRouterMeta();
    const byId = new Map(metas.map((m) => [m.id, m]));
    const helpers = new Set(choice().helpers);
    const items: ProfileInput[] = [];
    for (const m of catalog) {
      if (!(isFreeModel(m) || isSubscriptionModel(m) || helpers.has(refString(m)))) continue;
      if (m.providerID === 'openrouter') {
        const meta = byId.get(m.id);
        if (meta) items.push(fromOpenRouter(meta));
        continue;
      }
      const twin = matchOpenRouter(m, metas);
      items.push({
        ref: refString(m), name: twin ? `${m.name} (как ${twin.name} на OpenRouter)` : m.name, description: twin?.description ?? '',
        input: twin?.input ?? (m.vision ? ['text', 'image'] : ['text']),
        params: [...(m.tools ? ['tools'] : []), ...(m.variants.length ? ['reasoning'] : [])],
        context: m.context, expiresAt: null,
      });
    }
    const n = await profiles.refresh(items, (prompt) => gateway.complete({ role: 'chat', messages: [{ role: 'user', text: prompt }], json: true, title: 'model-profiles' }));
    if (n) console.log(`model profiles: ${n} updated`);
    return n;
  }

  // For Settings: the model's one-line summary and its strongest skills
  function profileView(ref: string): { summary: string | null; strengths: string[] } {
    const p = profiles.get(ref);
    if (!p) return { summary: null, strengths: [] };
    const top = SKILLS.filter((k) => (p.skills[k] ?? 0) >= 3);
    return { summary: p.summary || null, strengths: (top.length ? top : SKILLS.filter((k) => (p.skills[k] ?? 0) >= 2)).map((k) => SKILL_LABELS[k]) };
  }

  let updateTimer: ReturnType<typeof setInterval> | null = null;

  return {
    status: (): OpencodeStatus => server.status(),
    catalog: () => catalog,
    choice,
    model,
    agentTurn,
    bridge,
    profileView,
    refreshProfiles,
    ledger,
    direct,

    // Settings → «Кому достанется задача»: the same routing a real task of this agent gets
    async route(agentName: string, task: string): Promise<AiRoute> {
      const role = agentRole(deps.agents().get(agentName).model);
      const needs = agentNeeds(agentName) ?? [];
      const need = { tools: true };
      const opts = routeOpts(needs);
      const pool = poolModels(catalog, choice(), role, need, opts).slice(0, 10);
      const byRef = new Map(catalog.map((m) => [refString(m), m]));
      let ranked: { ref: string; p: number | null }[] = pool.map((m) => ({ ref: refString(m), p: null }));
      if (pool.length > 1 && deps.getSettings().jevApiKey.trim()) {
        ranked = await jevRankModels(deps.getSettings, task, needs.length ? needs : ROLE_NEEDS[role], pool.map((m) => ({ ref: refString(m), text: modelText(m) })));
      }
      const order = rankModels(catalog, choice(), role, need, { ...opts, poolOrder: ranked.map((r) => r.ref) }).slice(0, MAX_ATTEMPTS).map(refOf);
      return {
        role, needs: needs.length ? needs : ROLE_NEEDS[role], order,
        ranked: ranked.map((r) => ({ ...r, name: byRef.get(r.ref)?.name ?? r.ref })),
      };
    },

    async start() {
      setLlmGateway(gateway);
      await bridge.start();
      writeConfig();
      await server.start();
      await refreshCatalog();
      void refreshProfiles().catch((e) => console.error('model profiles', e)); // in the background: the engine works without them
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
      await refreshProfiles().catch((e) => console.error('model profiles', e));
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

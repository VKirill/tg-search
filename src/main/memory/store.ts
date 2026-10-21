import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type {
  AppEvent,
  Asset,
  AssetRole,
  ChatMessage,
  Client,
  FactKind,
  Lead,
  MemoryEpisode,
  MemoryFact,
  Order,
  Settings,
} from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine } from '../telegram/types';
import { listAuthorizedProjectAccounts } from '../pipeline/accounts';
import { compactDialog, type FetchFn } from './aux';
import { captionImage } from './caption';
import { extractDocumentText } from './docText';
import { createWorkerEmbedder, dot, type Embedder } from './embedder';
import { reciprocalRankFusion } from './hybrid';
import { ensureMemorySchema } from './schema';
import type { AgentContext, MemorySearchResult, MemoryStore } from './types';

const SILENCE_MS = 6 * 60 * 60 * 1000;
const MSGS_PER_EPISODE = 30;
const EMBED_DIM = 768;

type Row = Record<string, unknown>;

export interface MemoryStoreDeps {
  db: Db;
  engine: TelegramEngine;
  dataDir: string;
  settings: () => Settings;
  emit: (e: AppEvent) => void;
  embedder?: Embedder;
  fetchFn?: FetchFn;
}

export interface MemoryStoreApi extends MemoryStore {
  sendAsset(leadId: number, assetId: number): Promise<void>;
  searchAsync(clientId: number, query: string): Promise<MemorySearchResult>;
  listClients(search?: string): Client[];
  getClient(clientId: number): Client;
  listFacts(clientId: number): MemoryFact[];
  removeFact(factId: number): void;
  listEpisodes(clientId: number): MemoryEpisode[];
  listAssets(clientId: number, query?: string): Asset[];
}

export function createMemoryStore(deps: MemoryStoreDeps): MemoryStoreApi {
  const raw = deps.db.raw;
  ensureMemorySchema(raw);
  const fetchFn = deps.fetchFn ?? fetch;
  const embedder = deps.embedder ?? createWorkerEmbedder(deps.dataDir);
  const indexedPaths = new Set<string>();
  const queryVecCache = new Map<string, Float32Array>();

  function emitUpdate(clientId: number) {
    deps.emit({ type: 'memory:update', clientId });
  }

  function one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return raw.prepare(sql).get(...args) as Row | undefined;
  }

  function all(sql: string, ...args: SQLInputValue[]): Row[] {
    return raw.prepare(sql).all(...args) as Row[];
  }

  function run(sql: string, ...args: SQLInputValue[]) {
    return raw.prepare(sql).run(...args);
  }

  function setLeadClientId(leadId: number, clientId: number) {
    run('UPDATE leads SET client_id = ? WHERE id = ?', clientId, leadId);
  }

  function toClient(r: Row): Client {
    const leadIds = all('SELECT id FROM leads WHERE client_id = ? ORDER BY id', Number(r.id)).map((x) => Number(x.id));
    return {
      id: Number(r.id),
      tgUserId: r.tg_user_id != null ? Number(r.tg_user_id) : null,
      name: String(r.name),
      username: r.username != null ? String(r.username) : null,
      leadIds,
      createdAt: Number(r.created_at),
      lastSeenAt: r.last_seen_at != null ? Number(r.last_seen_at) : null,
    };
  }

  function toFact(r: Row): MemoryFact {
    return {
      id: Number(r.id),
      clientId: Number(r.client_id),
      kind: r.kind as FactKind,
      text: String(r.text),
      source: r.source != null ? String(r.source) : null,
      active: !!r.active,
      createdAt: Number(r.created_at),
    };
  }

  function toEpisode(r: Row): MemoryEpisode {
    return {
      id: Number(r.id),
      clientId: Number(r.client_id),
      fromMs: Number(r.from_ms),
      toMs: Number(r.to_ms),
      summary: String(r.summary),
      messages: Number(r.messages),
    };
  }

  function toAsset(r: Row): Asset {
    return {
      id: Number(r.id),
      clientId: Number(r.client_id),
      orderId: r.order_id != null ? Number(r.order_id) : null,
      path: String(r.path),
      mime: String(r.mime),
      name: String(r.name),
      role: r.role as AssetRole,
      caption: String(r.caption),
      tags: JSON.parse(String(r.tags || '[]')) as string[],
      createdAt: Number(r.created_at),
    };
  }

  function ftsQuery(q: string): string {
    const tokens = q
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}_]+/gu, ''))
      .filter((t) => t.length >= 2);
    if (!tokens.length) return '';
    return tokens.map((t) => `"${t}"*`).join(' OR ');
  }

  function indexFts(clientId: number, ownerType: string, ownerId: number, body: string) {
    const text = body.trim();
    if (!text) return;
    run('DELETE FROM memory_fts WHERE owner_type = ? AND owner_id = ?', ownerType, ownerId);
    run('INSERT INTO memory_fts(body, client_id, owner_type, owner_id) VALUES(?, ?, ?, ?)', text, clientId, ownerType, ownerId);
  }

  async function storeVector(
    clientId: number,
    ownerType: string,
    ownerId: number,
    modality: string,
    vec: Float32Array | null,
  ) {
    if (!vec || vec.length !== EMBED_DIM) return;
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    run(
      `INSERT INTO memory_vectors(owner_type, owner_id, modality, client_id, dim, vec)
       VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_type, owner_id, modality) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
      ownerType,
      ownerId,
      modality,
      clientId,
      EMBED_DIM,
      blob,
    );
  }

  async function embedFact(fact: MemoryFact) {
    const vec = await embedder.embedDocument(fact.text, fact.kind);
    await storeVector(fact.clientId, 'fact', fact.id, 'text', vec);
  }

  function assetDir(clientId: number): string {
    const dir = join(deps.dataDir, 'clients', String(clientId), 'assets');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function ensureMeta(clientId: number) {
    if (!one('SELECT 1 FROM memory_client_meta WHERE client_id = ?', clientId)) {
      run('INSERT INTO memory_client_meta(client_id) VALUES(?)', clientId);
    }
  }

  function ensureClient(lead: Lead): Client | null {
    if (lead.authorUserId == null) return lead.clientId ? getClient(lead.clientId) : null;
    let row = one('SELECT * FROM clients WHERE tg_user_id = ?', lead.authorUserId);
    if (!row) {
      const now = Date.now();
      run(
        'INSERT INTO clients(tg_user_id, name, username, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?)',
        lead.authorUserId,
        lead.authorName ?? 'Клиент',
        lead.authorUsername,
        now,
        now,
      );
      row = one('SELECT * FROM clients WHERE tg_user_id = ?', lead.authorUserId)!;
      ensureMeta(Number(row.id));
    }
    const client = toClient(row);
    if (lead.clientId !== client.id) setLeadClientId(lead.id, client.id);
    return client;
  }

  function clientForLead(leadId: number): Client | null {
    let lead: Lead;
    try {
      lead = deps.db.getLead(leadId);
    } catch {
      return null; // unknown lead, e.g. the sandbox's temporary lead
    }
    if (lead.clientId) {
      const r = one('SELECT * FROM clients WHERE id = ?', lead.clientId);
      return r ? toClient(r) : null;
    }
    return ensureClient(lead);
  }

  function getClient(clientId: number): Client {
    const r = one('SELECT * FROM clients WHERE id = ?', clientId);
    if (!r) throw new Error(`client ${clientId} not found`);
    return toClient(r);
  }

  function listClients(search?: string): Client[] {
    if (!search?.trim()) {
      return all('SELECT * FROM clients ORDER BY COALESCE(last_seen_at, 0) DESC, id DESC').map(toClient);
    }
    const q = `%${search.trim()}%`;
    return all(
      'SELECT * FROM clients WHERE name LIKE ? OR username LIKE ? ORDER BY COALESCE(last_seen_at, 0) DESC',
      q,
      q,
    ).map(toClient);
  }

  function touchClient(clientId: number, at: number) {
    run('UPDATE clients SET last_seen_at = ? WHERE id = ?', at, clientId);
  }

  function remember(clientId: number, kind: FactKind, text: string, source: string | null): MemoryFact {
    const now = Date.now();
    const res = run(
      'INSERT INTO memory_facts(client_id, kind, text, source, active, created_at) VALUES(?, ?, ?, ?, 1, ?)',
      clientId,
      kind,
      text.trim(),
      source,
      now,
    );
    const fact = toFact(one('SELECT * FROM memory_facts WHERE id = ?', Number(res.lastInsertRowid))!);
    indexFts(clientId, 'fact', fact.id, fact.text);
    void embedFact(fact).then(() => emitUpdate(clientId));
    emitUpdate(clientId);
    return fact;
  }

  async function supersedeNearDuplicate(clientId: number, text: string, kind: FactKind): Promise<boolean> {
    const vec = await embedder.embedDocument(text, kind);
    if (!vec) return false;
    const active = all('SELECT id, text, kind FROM memory_facts WHERE client_id = ? AND active = 1', clientId);
    for (const f of active) {
      const row = one(
        'SELECT vec FROM memory_vectors WHERE owner_type = ? AND owner_id = ? AND modality = ?',
        'fact',
        Number(f.id),
        'text',
      );
      if (!row?.vec) continue;
      const buf = row.vec as Buffer;
      const other = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      if (dot(vec, other) > 0.92) return true;
    }
    return false;
  }

  function rememberExtracted(clientId: number, facts: { kind: FactKind; text: string }[], source: string) {
    for (const f of facts) {
      void (async () => {
        if (await supersedeNearDuplicate(clientId, f.text, f.kind)) return;
        const existing = all(
          'SELECT id FROM memory_facts WHERE client_id = ? AND active = 1 AND lower(text) = lower(?)',
          clientId,
          f.text,
        );
        if (existing.length) return;
        remember(clientId, f.kind, f.text, source);
      })();
    }
  }

  function removeFact(factId: number) {
    const f = one('SELECT * FROM memory_facts WHERE id = ?', factId);
    if (!f) return;
    run('UPDATE memory_facts SET active = 0 WHERE id = ?', factId);
    emitUpdate(Number(f.client_id));
  }

  function listFacts(clientId: number): MemoryFact[] {
    return all('SELECT * FROM memory_facts WHERE client_id = ? ORDER BY created_at DESC', clientId).map(toFact);
  }

  function listEpisodes(clientId: number): MemoryEpisode[] {
    return all('SELECT * FROM memory_episodes WHERE client_id = ? ORDER BY to_ms DESC', clientId).map(toEpisode);
  }

  async function indexAsset(asset: Asset, imagePath?: string) {
    const body = [asset.caption, asset.name, asset.tags.join(' ')].filter(Boolean).join(' ');
    indexFts(asset.clientId, 'asset', asset.id, body);
    const textVec = await embedder.embedDocument(body, asset.name);
    await storeVector(asset.clientId, 'asset', asset.id, 'text', textVec);
    if (imagePath && asset.mime.startsWith('image/')) {
      const imgVec = await embedder.embedImage(imagePath);
      await storeVector(asset.clientId, 'asset', asset.id, 'image', imgVec);
    }
    emitUpdate(asset.clientId);
  }

  function addAsset(a: {
    clientId: number;
    orderId: number | null;
    path: string;
    mime: string;
    name: string;
    role: AssetRole;
    caption?: string;
    tags?: string[];
  }): Asset {
    if (!existsSync(a.path)) throw new Error('file missing');
    const now = Date.now();
    const res = run(
      `INSERT INTO memory_assets(client_id, order_id, path, mime, name, role, caption, tags, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.clientId,
      a.orderId,
      a.path,
      a.mime,
      a.name,
      a.role,
      a.caption ?? '',
      JSON.stringify(a.tags ?? []),
      now,
    );
    const asset = toAsset(one('SELECT * FROM memory_assets WHERE id = ?', Number(res.lastInsertRowid))!);
    void indexAsset(asset, a.mime.startsWith('image/') ? a.path : undefined);
    return asset;
  }

  function copyToClientAsset(clientId: number, srcPath: string, name: string): string {
    const safe = basename(name).replace(/[^\w.\-()+@]+/g, '_') || 'file';
    const dest = join(assetDir(clientId), `${Date.now()}-${safe}`);
    copyFileSync(srcPath, dest);
    return dest;
  }

  function captureFileAsset(
    clientId: number,
    orderId: number | null,
    srcPath: string,
    mime: string,
    name: string,
    role: AssetRole,
  ) {
    if (!existsSync(srcPath) || indexedPaths.has(srcPath)) return;
    indexedPaths.add(srcPath);
    const path = copyToClientAsset(clientId, srcPath, name);
    const asset = addAsset({ clientId, orderId, path, mime, name, role, caption: '', tags: [] });
    void (async () => {
      let caption = '';
      let tags: string[] = [];
      try {
        if (mime.startsWith('image/')) {
          const c = await captionImage(deps.settings(), path, fetchFn);
          caption = c.caption;
          tags = c.tags;
        } else {
          const text = extractDocumentText(path);
          if (text) {
            caption = text.slice(0, 500);
            tags = ['документ'];
          }
        }
      } catch {
        return;
      }
      if (!caption && !tags.length) return;
      run('UPDATE memory_assets SET caption = ?, tags = ? WHERE id = ?', caption, JSON.stringify(tags), asset.id);
      const updated = toAsset(one('SELECT * FROM memory_assets WHERE id = ?', asset.id)!);
      await indexAsset(updated, mime.startsWith('image/') ? path : undefined);
    })();
  }

  function searchFts(clientId: number, query: string): { ownerType: string; ownerId: number }[] {
    const q = ftsQuery(query);
    if (!q) return [];
    try {
      return all(
        `SELECT owner_type, owner_id FROM memory_fts WHERE memory_fts MATCH ? AND client_id = ? ORDER BY bm25(memory_fts) LIMIT 20`,
        q,
        clientId,
      ).map((r) => ({ ownerType: String(r.owner_type), ownerId: Number(r.owner_id) }));
    } catch {
      return [];
    }
  }

  function vectorHits(clientId: number, qVec: Float32Array): { ownerType: string; ownerId: number }[] {
    const rows = all('SELECT owner_type, owner_id, vec FROM memory_vectors WHERE client_id = ?', clientId);
    const scored: { ownerType: string; ownerId: number; score: number }[] = [];
    for (const r of rows) {
      const buf = r.vec as Buffer;
      const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      scored.push({ ownerType: String(r.owner_type), ownerId: Number(r.owner_id), score: dot(qVec, v) });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map(({ ownerType, ownerId }) => ({ ownerType, ownerId }));
  }

  async function searchVectors(clientId: number, query: string): Promise<{ ownerType: string; ownerId: number }[]> {
    const qVec = await embedder.embedQuery(query);
    if (!qVec) return [];
    return vectorHits(clientId, qVec);
  }

  function search(clientId: number, query: string): MemorySearchResult {
    const ftsHits = searchFts(clientId, query);
    const qVec = embedder.embedQuerySync?.(query) ?? queryVecCache.get(query) ?? null;
    if (!embedder.embedQuerySync && !queryVecCache.has(query)) {
      void embedder.embedQuery(query).then((v) => {
        if (v) queryVecCache.set(query, v);
      });
    }
    const vecHits = qVec ? vectorHits(clientId, qVec) : [];
    const merged = reciprocalRankFusion([ftsHits, vecHits]);
    return loadSearchResults(clientId, merged, query);
  }

  async function searchAsync(clientId: number, query: string): Promise<MemorySearchResult> {
    const ftsHits = searchFts(clientId, query);
    const qVec = await embedder.embedQuery(query);
    if (qVec) queryVecCache.set(query, qVec);
    const vecHits = qVec ? vectorHits(clientId, qVec) : [];
    const merged = reciprocalRankFusion([ftsHits, vecHits]);
    return loadSearchResults(clientId, merged, query);
  }

  function loadSearchResults(
    clientId: number,
    merged: { ownerType: string; ownerId: number }[],
    query: string,
  ): MemorySearchResult {
    const out: MemorySearchResult = { facts: [], episodes: [], assets: [] };
    for (const hit of merged) {
      if (hit.ownerType === 'fact' && out.facts.length < 10) {
        const r = one('SELECT * FROM memory_facts WHERE id = ? AND client_id = ? AND active = 1', hit.ownerId, clientId);
        if (r) out.facts.push(toFact(r));
      } else if (hit.ownerType === 'episode' && out.episodes.length < 5) {
        const r = one('SELECT * FROM memory_episodes WHERE id = ? AND client_id = ?', hit.ownerId, clientId);
        if (r) out.episodes.push(toEpisode(r));
      } else if (hit.ownerType === 'asset' && out.assets.length < 5) {
        const r = one('SELECT * FROM memory_assets WHERE id = ? AND client_id = ?', hit.ownerId, clientId);
        if (r) out.assets.push(toAsset(r));
      }
    }
    if (!query.trim() && out.assets.length === 0) {
      out.assets.push(
        ...all('SELECT * FROM memory_assets WHERE client_id = ? ORDER BY created_at DESC LIMIT 5', clientId).map(toAsset),
      );
    }
    return out;
  }

  function listAssets(clientId: number, query?: string): Asset[] {
    if (!query?.trim()) {
      return all('SELECT * FROM memory_assets WHERE client_id = ? ORDER BY created_at DESC', clientId).map(toAsset);
    }
    return search(clientId, query).assets;
  }

  async function compactEpisode(clientId: number, fromMs: number, toMs: number, messageCount: number) {
    const leadIds = all('SELECT id FROM leads WHERE client_id = ?', clientId).map((r) => Number(r.id));
    const lines: string[] = [];
    for (const leadId of leadIds) {
      for (const m of deps.db.listMessages(leadId)) {
        if (m.date < fromMs || m.date > toMs) continue;
        if (m.kind === 'note') continue;
        const who = m.direction === 'in' ? 'Клиент' : 'Мы';
        lines.push(`${who}: ${m.text}`);
      }
    }
    if (!lines.length) return;
    const compact = await compactDialog(deps.settings(), lines, fetchFn);
    if (!compact) return;
    const res = run(
      'INSERT INTO memory_episodes(client_id, from_ms, to_ms, summary, messages) VALUES(?, ?, ?, ?, ?)',
      clientId,
      fromMs,
      toMs,
      compact.summary,
      messageCount,
    );
    const ep = toEpisode(one('SELECT * FROM memory_episodes WHERE id = ?', Number(res.lastInsertRowid))!);
    indexFts(clientId, 'episode', ep.id, ep.summary);
    void embedder.embedDocument(ep.summary, 'episode').then((v) => storeVector(clientId, 'episode', ep.id, 'text', v));
    rememberExtracted(clientId, compact.facts, `episode ${ep.id}`);
    emitUpdate(clientId);
  }

  function resetCompactWindow(clientId: number, fromMs: number) {
    run(
      'UPDATE memory_client_meta SET msgs_since_compact = 0, window_from_ms = ?, last_incoming_ms = ? WHERE client_id = ?',
      fromMs,
      fromMs,
      clientId,
    );
  }

  async function maybeCompact(clientId: number, msg: ChatMessage) {
    if (msg.direction !== 'in') return;
    ensureMeta(clientId);
    const meta = one('SELECT * FROM memory_client_meta WHERE client_id = ?', clientId)!;
    const last = meta.last_incoming_ms != null ? Number(meta.last_incoming_ms) : null;
    const windowFrom = meta.window_from_ms != null ? Number(meta.window_from_ms) : msg.date;
    let msgs = Number(meta.msgs_since_compact);

    if (last != null && msg.date - last > SILENCE_MS && msgs > 0) {
      await compactEpisode(clientId, windowFrom, last, msgs);
      msgs = 0;
    }

    msgs += 1;
    run(
      'UPDATE memory_client_meta SET msgs_since_compact = ?, window_from_ms = ?, last_incoming_ms = ? WHERE client_id = ?',
      msgs,
      msgs === 1 ? msg.date : windowFrom,
      msg.date,
      clientId,
    );

    if (msgs >= MSGS_PER_EPISODE) {
      await compactEpisode(clientId, windowFrom, msg.date, msgs);
      resetCompactWindow(clientId, msg.date);
    }
  }

  async function indexMessage(clientId: number, message: ChatMessage) {
    indexFts(clientId, 'message', message.id, message.text);
    const vec = await embedder.embedDocument(message.text, `message ${message.id}`);
    await storeVector(clientId, 'message', message.id, 'text', vec);
  }

  function onMessage(message: ChatMessage) {
    const lead = deps.db.getLead(message.leadId);
    const client = ensureClient(lead);
    if (!client) return;
    touchClient(client.id, message.date);
    void maybeCompact(client.id, message);
    void indexMessage(client.id, message);

    if (message.direction === 'in' && message.mediaPath && existsSync(message.mediaPath)) {
      const mime =
        message.kind === 'voice'
          ? 'audio/ogg'
          : message.mediaPath.endsWith('.png')
            ? 'image/png'
            : message.mediaPath.endsWith('.pdf')
              ? 'application/pdf'
              : 'image/jpeg';
      captureFileAsset(client.id, null, message.mediaPath, mime, basename(message.mediaPath), 'from_client');
    }
  }

  function onOrder(order: Order) {
    const lead = deps.db.getLead(order.leadId);
    const client = ensureClient(lead);
    if (!client) return;
    for (const f of order.files) {
      if (f.role === 'preview') {
        captureFileAsset(client.id, order.id, f.path, f.mime, f.name, 'preview');
      }
      if (f.role === 'output') {
        captureFileAsset(client.id, order.id, f.path, f.mime, f.name, 'delivered');
      }
    }
  }

  function estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  function context(leadId: number, query: string, budgetTokens = 6000): AgentContext {
    const client = clientForLead(leadId);
    if (!client) return { text: '', tokens: 0 };

    const sections: string[] = [];
    const facts = all('SELECT * FROM memory_facts WHERE client_id = ? AND active = 1 ORDER BY created_at DESC', client.id).map(
      toFact,
    );
    if (facts.length) {
      sections.push('## Факты\n' + facts.map((f) => `- (${f.kind}) ${f.text}`).join('\n'));
    }

    const episodes = all(
      'SELECT * FROM memory_episodes WHERE client_id = ? ORDER BY to_ms DESC LIMIT 3',
      client.id,
    ).map(toEpisode);
    if (episodes.length) {
      sections.push('## Эпизоды\n' + episodes.map((e) => `- ${e.summary.replace(/\n/g, ' ')}`).join('\n'));
    }

    const messages = deps.db.listMessages(leadId).filter((m) => m.kind !== 'note');
    const tail = messages.slice(-30);
    const msgLines = tail.map((m) => {
      const who = m.direction === 'in' ? 'Клиент' : m.auto ? 'ИИ' : 'Мы';
      const kind =
        m.kind === 'voice' ? ' [голос]' : m.kind === 'call' ? ' [созвон]' : '';
      return `- ${who}${kind}: ${m.text}`;
    });

    const openStatuses = new Set(['collecting', 'quoted', 'awaiting_payment', 'paid', 'in_progress', 'revision']);
    const orders = deps.db.listOrders(leadId).filter((o) => openStatuses.has(o.status));
    if (orders.length) {
      sections.push(
        '## Заказы\n' +
          orders.map((o) => `- #${o.id} ${o.status}: ${o.brief.slice(0, 120)}`).join('\n'),
      );
    }

    const assets = search(client.id, query).assets.slice(0, 5);
    if (assets.length) {
      sections.push(
        '## Файлы\n' +
          assets
            .map((a) => `- #${a.id} ${a.role}: ${a.caption || a.name} (${new Date(a.createdAt).toISOString().slice(0, 10)})`)
            .join('\n'),
      );
    }

    function assemble(trimMessages: number): string {
      const parts = [...sections];
      if (msgLines.length) {
        parts.push('## Сообщения\n' + msgLines.slice(-trimMessages).join('\n'));
      }
      return parts.join('\n\n');
    }

    let trim = msgLines.length;
    let text = assemble(trim);
    let tokens = estimateTokens(text);
    while (tokens > budgetTokens && trim > 3) {
      trim -= 1;
      text = assemble(trim);
      tokens = estimateTokens(text);
    }

    return { text, tokens };
  }

  async function sendAsset(leadId: number, assetId: number): Promise<void> {
    const lead = deps.db.getLead(leadId);
    const asset = toAsset(one('SELECT * FROM memory_assets WHERE id = ?', assetId)!);
    const project = deps.db.getProject(lead.projectId);
    const accountId =
      lead.accountId ?? listAuthorizedProjectAccounts(deps.db, project.accountIds)[0]?.id;
    if (accountId == null || lead.authorUserId == null) throw new Error('Нет аккаунта для отправки');
    const chatId = await deps.engine.ensurePrivateChat(accountId, lead.authorUserId);
    if (asset.mime.startsWith('image/')) {
      await deps.engine.sendPhoto(accountId, chatId, asset.path, asset.name);
    } else {
      await deps.engine.sendDocument(accountId, chatId, asset.path, asset.name);
    }
    const message = deps.db.addMessage({
      leadId,
      accountId,
      direction: 'out',
      where: 'dm',
      kind: 'text',
      text: `[файл: ${asset.name}]`,
      tgChatId: chatId,
      tgMessageId: null,
      date: Date.now(),
      auto: false,
    });
    deps.emit({ type: 'message:new', message });
  }

  function stop() {
    embedder.stop();
  }

  const api: MemoryStoreApi = {
    ensureClient,
    clientForLead,
    context,
    remember,
    search,
    addAsset,
    onMessage,
    onOrder,
    stop,
    sendAsset,
    searchAsync,
    listClients,
    getClient,
    listFacts,
    removeFact,
    listEpisodes,
    listAssets,
  };

  return api;
}

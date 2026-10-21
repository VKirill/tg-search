// Knowledge bases: the owner's materials (books and notes in Markdown, articles, manuals, product docs) that an
// assistant answers from. Documents are split into passages by headings and paragraphs, indexed for full-text search
// and embedded locally (the app's EmbeddingGemma); a question finds the closest passages by both, and they go into the
// agent's context with their sources (retrieval-augmented answers).
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { KnowledgeBase, KnowledgeDoc, KnowledgeHit } from '../../shared/types';
import type { Db } from '../db';
import { dot, type Embedder } from '../memory/embedder';
import { reciprocalRankFusion } from '../memory/hybrid';
import { assertPublicHttpUrl } from '../agent/web';

const CHUNK_CHARS = 1200; // a passage: a few paragraphs under their heading
const MAX_DOC_CHARS = 3_000_000; // a big book
const EMBED_DIM = 768;

// Text of a file the owner adds: Markdown and text as is, HTML without tags, PDF through pdftotext
export function fileText(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf') {
    const r = spawnSync('pdftotext', ['-q', '-layout', path, '-'], { encoding: 'utf8', maxBuffer: MAX_DOC_CHARS * 4 });
    if (r.status !== 0 || !r.stdout?.trim()) throw new Error('не удалось прочитать PDF (нужен pdftotext: brew install poppler)');
    return r.stdout;
  }
  const raw = readFileSync(path, 'utf8');
  return ext === '.html' || ext === '.htm' ? htmlText(raw) : raw;
}

// HTML → text that keeps the structure: headings become «#», paragraphs and list items stay on their own lines
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|nav|footer|header|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${'#'.repeat(Number(n))} ${t.replace(/<[^>]+>/g, '').trim()}\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|tr|li|ul|ol|table|blockquote|pre)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// Passages of about CHUNK_CHARS: split by headings, then paragraphs; each passage knows its heading path
export function chunkText(text: string): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  const path: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n\n').trim();
    if (body) out.push({ heading: path.filter(Boolean).join(' › '), text: body });
    buf = [];
  };
  // a heading line is its own block even without blank lines around it
  for (const block of text.replace(/\r/g, '').replace(/^(#{1,6}\s.+)$/gm, '\n$1\n').split(/\n\s*\n/)) {
    const h = /^(#{1,6})\s+(.+)$/.exec(block.trim());
    if (h) {
      flush();
      path.splice(h[1].length - 1, path.length, h[2].trim());
      continue;
    }
    const piece = block.trim();
    if (!piece) continue;
    if (buf.join('\n\n').length + piece.length > CHUNK_CHARS && buf.length) flush();
    // a single huge paragraph (a PDF page without blank lines, a long list) is cut by lines and sentences, never mid-word
    if (piece.length > CHUNK_CHARS * 1.5) {
      flush();
      let part = '';
      for (const unit of piece.split(/(?<=[.!?…])\s+|\n/)) {
        // a «sentence» longer than a passage (a table, a dump) has nothing better to break at than its length
        for (let i = 0; i < unit.length; i += CHUNK_CHARS) {
          const slice = unit.slice(i, i + CHUNK_CHARS);
          if (part && part.length + slice.length > CHUNK_CHARS) {
            buf.push(part);
            flush();
            part = '';
          }
          part += (part ? ' ' : '') + slice;
        }
      }
      if (part) {
        buf.push(part);
        flush();
      }
      continue;
    }
    buf.push(piece);
  }
  flush();
  return out;
}

type Row = Record<string, any>;

export function createKnowledge(deps: { db: Db; embedder: Embedder; fetchFn?: typeof fetch }) {
  const raw = deps.db.raw;
  raw.exec(`CREATE TABLE IF NOT EXISTS kb_bases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kb_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    base_id INTEGER NOT NULL REFERENCES kb_bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '', -- file path, URL or «вставлен текст»
    chars INTEGER NOT NULL DEFAULT 0,
    chunks INTEGER NOT NULL DEFAULT 0,
    embedded INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'indexing', -- indexing | ready | failed
    error TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kb_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id INTEGER NOT NULL REFERENCES kb_docs(id) ON DELETE CASCADE,
    base_id INTEGER NOT NULL,
    ord INTEGER NOT NULL,
    heading TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL,
    vec BLOB
  );
  CREATE INDEX IF NOT EXISTS kb_chunks_base ON kb_chunks(base_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(text, heading, chunk_id UNINDEXED, base_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2');`);
  raw.exec('PRAGMA foreign_keys = ON');

  const docView = (r: Row): KnowledgeDoc => ({
    id: r.id, baseId: r.base_id, title: r.title, source: r.source, chars: r.chars, chunks: r.chunks, embedded: r.embedded,
    status: r.status, error: r.error, createdAt: r.created_at,
  });

  function listBases(): KnowledgeBase[] {
    return (raw.prepare(`SELECT b.*, COUNT(d.id) AS docs, COALESCE(SUM(d.chunks), 0) AS chunks FROM kb_bases b
      LEFT JOIN kb_docs d ON d.base_id = b.id GROUP BY b.id ORDER BY b.name`).all() as Row[])
      .map((r) => ({ id: r.id, name: r.name, description: r.description, docs: r.docs, chunks: r.chunks, createdAt: r.created_at }));
  }

  // Passages embed in the background, one by one: a book of thousands of passages does not block anything
  let embedding = Promise.resolve();
  function embedDoc(docId: number) {
    embedding = embedding.then(async () => {
      const rows = raw.prepare('SELECT c.id, c.text, c.heading, d.title FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id WHERE c.doc_id = ? AND c.vec IS NULL ORDER BY c.ord').all(docId) as Row[];
      for (const r of rows) {
        if (!raw.prepare('SELECT 1 FROM kb_docs WHERE id = ?').get(docId)) return; // removed meanwhile
        const v = await deps.embedder.embedDocument(r.text, [r.title, r.heading].filter(Boolean).join(' › ')).catch(() => null);
        if (v && v.length === EMBED_DIM) raw.prepare('UPDATE kb_chunks SET vec = ? WHERE id = ?').run(Buffer.from(v.buffer, v.byteOffset, v.byteLength), r.id);
        raw.prepare('UPDATE kb_docs SET embedded = embedded + 1 WHERE id = ?').run(docId);
      }
      raw.prepare("UPDATE kb_docs SET status = 'ready' WHERE id = ? AND status = 'indexing'").run(docId);
    }).catch((err) => console.error('knowledge embed', docId, err));
  }

  function addText(baseId: number, title: string, text: string, source: string): KnowledgeDoc {
    const body = text.slice(0, MAX_DOC_CHARS);
    const chunks = chunkText(body);
    if (!chunks.length) throw new Error('в документе нет текста');
    const docId = Number(raw.prepare('INSERT INTO kb_docs(base_id, title, source, chars, chunks, created_at) VALUES(?, ?, ?, ?, ?, ?)')
      .run(baseId, title.slice(0, 200), source, body.length, chunks.length, Date.now()).lastInsertRowid);
    const insert = raw.prepare('INSERT INTO kb_chunks(doc_id, base_id, ord, heading, text) VALUES(?, ?, ?, ?, ?)');
    const fts = raw.prepare('INSERT INTO kb_fts(text, heading, chunk_id, base_id) VALUES(?, ?, ?, ?)');
    raw.exec('BEGIN');
    try {
      chunks.forEach((c, i) => {
        const id = Number(insert.run(docId, baseId, i, c.heading, c.text).lastInsertRowid);
        fts.run(c.text, c.heading, id, baseId);
      });
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw err;
    }
    embedDoc(docId);
    return docView(raw.prepare('SELECT * FROM kb_docs WHERE id = ?').get(docId) as Row);
  }

  // A question → the closest passages of the given bases: full-text and meaning, fused by rank
  async function search(baseIds: number[], query: string, k = 6): Promise<KnowledgeHit[]> {
    if (!baseIds.length || !query.trim()) return [];
    const marks = baseIds.map(() => '?').join(',');
    const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
    const fts = terms.length
      ? (raw.prepare(`SELECT chunk_id FROM kb_fts WHERE kb_fts MATCH ? AND base_id IN (${marks}) ORDER BY bm25(kb_fts) LIMIT 30`)
        .all(terms.map((t) => `"${t}"*`).join(' OR '), ...baseIds) as { chunk_id: number }[]).map((r) => ({ ownerType: 'c', ownerId: Number(r.chunk_id) }))
      : [];
    const q = await deps.embedder.embedQuery(query).catch(() => null);
    let near: { ownerType: string; ownerId: number }[] = [];
    if (q) {
      const scored: { id: number; s: number }[] = [];
      for (const r of raw.prepare(`SELECT id, vec FROM kb_chunks WHERE base_id IN (${marks}) AND vec IS NOT NULL`).iterate(...baseIds) as Iterable<Row>) {
        const b = r.vec as Uint8Array;
        scored.push({ id: r.id, s: dot(q, new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)) });
      }
      near = scored.sort((a, b) => b.s - a.s).slice(0, 30).map((x) => ({ ownerType: 'c', ownerId: x.id }));
    }
    const ids = reciprocalRankFusion([fts, near]).slice(0, k).map((h) => h.ownerId);
    if (!ids.length) return [];
    const rows = raw.prepare(`SELECT c.id, c.heading, c.text, d.title, d.source FROM kb_chunks c JOIN kb_docs d ON d.id = c.doc_id
      WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is Row => !!r)
      .map((r) => ({ docTitle: r.title, source: r.source, heading: r.heading, text: r.text }));
  }

  return {
    listBases,
    createBase(name: string, description = ''): KnowledgeBase[] {
      if (!name.trim()) throw new Error('Нужно название базы');
      raw.prepare('INSERT INTO kb_bases(name, description, created_at) VALUES(?, ?, ?)').run(name.trim(), description.trim(), Date.now());
      return listBases();
    },
    updateBase(id: number, patch: { name?: string; description?: string }): KnowledgeBase[] {
      if (patch.name !== undefined) raw.prepare('UPDATE kb_bases SET name = ? WHERE id = ?').run(patch.name.trim(), id);
      if (patch.description !== undefined) raw.prepare('UPDATE kb_bases SET description = ? WHERE id = ?').run(patch.description.trim(), id);
      return listBases();
    },
    removeBase(id: number): KnowledgeBase[] {
      raw.prepare('DELETE FROM kb_fts WHERE base_id = ?').run(id);
      raw.prepare('DELETE FROM kb_chunks WHERE base_id = ?').run(id);
      raw.prepare('DELETE FROM kb_docs WHERE base_id = ?').run(id);
      raw.prepare('DELETE FROM kb_bases WHERE id = ?').run(id);
      return listBases();
    },
    docs(baseId: number): KnowledgeDoc[] {
      return (raw.prepare('SELECT * FROM kb_docs WHERE base_id = ? ORDER BY id DESC').all(baseId) as Row[]).map(docView);
    },
    addText,
    addFile(baseId: number, path: string): KnowledgeDoc {
      return addText(baseId, basename(path).replace(/\.[^.]+$/, ''), fileText(path), path);
    },
    async addUrl(baseId: number, url: string): Promise<KnowledgeDoc> {
      const u = assertPublicHttpUrl(url.trim());
      const res = await (deps.fetchFn ?? fetch)(u.toString(), { redirect: 'follow', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'TG-Search-Knowledge/1.0' } });
      if (!res.ok) throw new Error(`страница не открылась: HTTP ${res.status}`);
      const body = await res.text();
      const isHtml = (res.headers.get('content-type') ?? '').includes('html') || /<html/i.test(body.slice(0, 500));
      const title = (isHtml ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() : '') || u.hostname + u.pathname;
      return addText(baseId, title, isHtml ? htmlText(body) : body, u.toString());
    },
    removeDoc(docId: number) {
      raw.prepare('DELETE FROM kb_fts WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE doc_id = ?)').run(docId);
      raw.prepare('DELETE FROM kb_chunks WHERE doc_id = ?').run(docId);
      raw.prepare('DELETE FROM kb_docs WHERE id = ?').run(docId);
    },
    search,
    // unfinished embedding after a restart picks up where it stopped
    resume() {
      for (const r of raw.prepare("SELECT id FROM kb_docs WHERE status = 'indexing'").all() as Row[]) embedDoc(r.id);
    },
    idle: () => embedding,
  };
}

export type Knowledge = ReturnType<typeof createKnowledge>;

// The passages for the agent, with their sources
export function knowledgeContext(hits: KnowledgeHit[], strict: boolean): string {
  if (!hits.length) {
    return strict ? '<knowledge>\nВ материалах ничего по этому вопросу не нашлось.\n</knowledge>\nОтвечай только по материалам: скажи, что в них этого нет, и не выдумывай.' : '';
  }
  const parts = hits.map((h, i) => `[${i + 1}] ${h.docTitle}${h.heading ? ` — ${h.heading}` : ''}\n${h.text}`);
  return [
    `<knowledge>\n${parts.join('\n\n')}\n</knowledge>`,
    strict
      ? 'Отвечай только по этим материалам. Чего в них нет — так и скажи, не выдумывай и не дополняй из общих знаний. Ссылайся на источник: «по [1]».'
      : 'Опирайся на эти материалы в первую очередь; если их не хватает — дополни, отметив, что это не из материалов.',
  ].join('\n');
}

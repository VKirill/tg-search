import { existsSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDLE_MS = 5 * 60 * 1000;

export interface Embedder {
  embedQuery(text: string): Promise<Float32Array | null>;
  embedDocument(text: string, title?: string): Promise<Float32Array | null>;
  embedImage(path: string): Promise<Float32Array | null>;
  /** Optional sync path for in-process fake embedders (tests). */
  embedQuerySync?(text: string): Float32Array | null;
  stop(): void;
}

type JobKind = 'query' | 'document' | 'image';

let nextId = 1;

export function createWorkerEmbedder(dataDir: string): Embedder {
  const cacheDir = join(dataDir, 'models');
  // the build puts the worker in out/main/memory/ next to the bundle's out/main/index.js (it was looked for one folder up
  // and never found: no embeddings were made, the semantic half of memory and knowledge search silently did nothing)
  const here = dirname(fileURLToPath(import.meta.url));
  const workerPath = [join(here, 'memory', 'embedder.worker.js'), join(here, 'embedder.worker.js')].find((p) => existsSync(p)) ?? join(here, 'embedder.worker.js');
  let worker: Worker | null = null;
  let available = true;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<number, { resolve: (v: Float32Array | null) => void; reject: (e: Error) => void }>();

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdle() {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (worker && pending.size === 0) {
        void send('unload', {}).finally(() => {
          worker?.terminate();
          worker = null;
        });
      }
    }, IDLE_MS);
    idleTimer.unref?.();
  }

  function ensureWorker(): Worker | null {
    if (!available) return null;
    if (worker) return worker;
    try {
      worker = new Worker(workerPath, { workerData: { cacheDir } });
      worker.on('message', (msg: { id: number; ok: boolean; vec?: number[]; error?: string }) => {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (!msg.ok || !msg.vec) {
          p.resolve(null);
          scheduleIdle();
          return;
        }
        p.resolve(normalize(new Float32Array(msg.vec))); // unit length: dot products are cosines, long texts get no edge
        scheduleIdle();
      });
      worker.on('error', (err) => {
        console.error('embedder worker failed — semantic search is off until restart:', err);
        available = false;
        for (const [, p] of pending) p.resolve(null);
        pending.clear();
        worker?.terminate();
        worker = null;
      });
      return worker;
    } catch {
      available = false;
      return null;
    }
  }

  function send(type: JobKind | 'unload', payload: Record<string, string | undefined>): Promise<Float32Array | null> {
    const w = ensureWorker();
    if (!w) return Promise.resolve(null);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      w.postMessage({ id, type, ...payload });
    });
  }

  return {
    embedQuery: (text) => send('query', { text }),
    embedDocument: (text, title) => send('document', { text, title }),
    embedImage: (path) => send('image', { path }),
    stop() {
      clearIdle();
      for (const [, p] of pending) p.resolve(null);
      pending.clear();
      worker?.terminate();
      worker = null;
    },
  };
}

/** Deterministic fake vectors for tests (768-dim, normalized). */
export function createFakeEmbedder(fn?: (text: string) => number): Embedder {
  const dim = 768;
  const vec = (seed: string): Float32Array => {
    if (fn) {
      const v = new Float32Array(dim);
      const n = fn(seed);
      v[0] = n;
      v[1] = 1 - n;
      return normalize(v);
    }
    const out = new Float32Array(dim);
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    for (let i = 0; i < dim; i++) {
      h = (h * 1103515245 + 12345 + i) | 0;
      out[i] = (h % 1000) / 1000 - 0.5;
    }
    return normalize(out);
  };
  const stub = async (text: string) => vec(text);
  const sync = (text: string) => vec(text);
  return {
    embedQuery: stub,
    embedDocument: (text, title) => stub(`${title ?? ''}:${text}`),
    embedImage: (path) => stub(`img:${path}`),
    embedQuerySync: sync,
    stop() {},
  };
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

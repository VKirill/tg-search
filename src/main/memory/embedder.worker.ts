// Local EmbeddingGemma 2 in a worker thread (CPU, q4). Loaded lazily on first request.

import { parentPort, workerData } from 'node:worker_threads';
import {
  embedDocumentText,
  embedImagePath,
  embedQueryText,
  setEmbedderCacheDir,
  unloadEmbedderModel,
} from './embedder-core';

setEmbedderCacheDir((workerData as { cacheDir: string }).cacheDir);

type Job =
  | { id: number; type: 'query'; text: string }
  | { id: number; type: 'document'; text: string; title?: string }
  | { id: number; type: 'image'; path: string }
  | { id: number; type: 'unload' };

async function handle(job: Job) {
  if (job.type === 'unload') {
    unloadEmbedderModel();
    parentPort!.postMessage({ id: job.id, ok: true });
    return;
  }
  try {
    let vec: Float32Array;
    if (job.type === 'query') vec = await embedQueryText(job.text);
    else if (job.type === 'document') vec = await embedDocumentText(job.text, job.title);
    else vec = await embedImagePath(job.path);
    parentPort!.postMessage({ id: job.id, ok: true, vec: Array.from(vec) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parentPort!.postMessage({ id: job.id, ok: false, error: message });
  }
}

const queue: Job[] = [];
let busy = false;

function pump() {
  if (busy || queue.length === 0) return;
  busy = true;
  const job = queue.shift()!;
  void handle(job).finally(() => {
    busy = false;
    pump();
  });
}

parentPort!.on('message', (job: Job) => {
  queue.push(job);
  pump();
});

// Memory watch: every minute the app's own memory goes to userData/logs/memory.jsonl, and a watchdog relieves pressure
// before macOS runs out of memory (owner saw Electron at 18.7 GB on 2026-10-21; the cause was not caught live).

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INTERVAL_MS = 60_000;
const RELIEVE_MB = 3 * 1024; // unload the local embedding model
const CRITICAL_MB = 6 * 1024; // log loudly; the owner should restart the app
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface ProcessMemory {
  type: string; // Browser (main), Tab (renderer), GPU, Utility…
  mb: number;
}

export function startMemoryWatch(opts: {
  dataDir: string;
  processes: () => ProcessMemory[]; // Electron app.getAppMetrics()
  relieve: () => void;
}): { stop(): void } {
  const dir = join(opts.dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'memory.jsonl');

  const tick = () => {
    const procs = opts.processes();
    const total = procs.reduce((s, p) => s + p.mb, 0);
    const heap = process.memoryUsage();
    const entry = {
      ts: new Date().toISOString(),
      totalMb: Math.round(total),
      processes: procs.map((p) => ({ type: p.type, mb: Math.round(p.mb) })),
      mainHeapMb: Math.round(heap.heapUsed / 1e6),
      mainExternalMb: Math.round(heap.external / 1e6),
      action: total > CRITICAL_MB ? 'critical' : total > RELIEVE_MB ? 'relieve' : undefined,
    };
    if (total > RELIEVE_MB) opts.relieve();
    if (total > CRITICAL_MB) console.error(`memory critical: ${Math.round(total)} MB`, entry.processes);
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('memory log', err);
    }
  };

  const timer = setInterval(tick, INTERVAL_MS);
  timer.unref();
  tick();
  return { stop: () => clearInterval(timer) };
}

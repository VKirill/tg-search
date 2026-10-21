// Memory watch: every minute the app's own memory goes to userData/logs/memory.jsonl, and a watchdog relieves pressure
// before macOS runs out of memory (owner saw Electron at 18.7 GB on 2026-10-21; the cause was not caught live).

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INTERVAL_MS = 15_000; // the leak seen live grew ~3 GB a minute
const RELIEVE_MB = 3 * 1024; // unload the local embedding model
const CRITICAL_MB = 6 * 1024; // capture what is growing, then quit before macOS runs out of memory
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface ProcessMemory {
  type: string; // Browser (main), Tab (renderer), GPU, Utility…
  pid: number;
  mb: number; // resident set; macOS swaps/compresses, so the watchdog uses the footprint below
}

// macOS «footprint» = what Activity Monitor and the Force Quit window show (includes compressed and swapped memory)
export function footprintMb(pid: number): number | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('/usr/bin/footprint', ['-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/Footprint:\s+([\d.]+)\s+(KB|MB|GB)/);
    if (!m) return null;
    const v = Number(m[1]);
    return m[2] === 'GB' ? v * 1024 : m[2] === 'KB' ? v / 1024 : v;
  } catch {
    return null;
  }
}

export function startMemoryWatch(opts: {
  dataDir: string;
  processes: () => ProcessMemory[]; // Electron app.getAppMetrics()
  relieve: () => void;
  critical: () => void; // quit the app
}): { stop(): void } {
  const dir = join(opts.dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'memory.jsonl');

  const tick = (): number => {
    const procs = opts.processes().map((p) => ({ ...p, mb: footprintMb(p.pid) ?? p.mb }));
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
    if (total > CRITICAL_MB) {
      console.error(`memory critical: ${Math.round(total)} MB`, entry.processes);
      captureEvidence(dir, procs);
    }
    try {
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
      appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('memory log', err);
    }
    return total;
  };

  const run = () => {
    if (tick() > CRITICAL_MB) opts.critical();
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  run();
  return { stop: () => clearInterval(timer) };
}

// Which memory regions and native stacks the biggest process has, so the next leak names its source
function captureEvidence(dir: string, procs: ProcessMemory[]) {
  const top = [...procs].sort((a, b) => b.mb - a.mb)[0];
  if (!top) return;
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    } catch (err) {
      return String(err);
    }
  };
  const report = [
    `${top.type} pid ${top.pid}: ${Math.round(top.mb)} MB`,
    run('/usr/bin/vmmap', ['--summary', String(top.pid)]),
    run('/usr/bin/sample', [String(top.pid), '3']),
  ].join('\n\n');
  try {
    appendFileSync(join(dir, `memory-critical-${Date.now()}.txt`), report);
  } catch (err) {
    console.error('memory evidence', err);
  }
}

// The main process console goes to userData/logs/main.log too: a packaged app has no terminal, and agent failures
// (a turn that errored, a route Jev picked) must be readable afterwards. Rotated at 5 MB, one previous file kept.
export function teeConsoleToFile(dataDir: string): void {
  const dir = join(dataDir, 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'main.log');
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
        const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : safeJson(a))).join(' ');
        appendFileSync(file, `${new Date().toISOString()} ${level.toUpperCase()} ${text}\n`);
      } catch {
        /* logging must never break the app */
      }
    };
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v)?.slice(0, 2000) ?? String(v);
  } catch {
    return String(v);
  }
}

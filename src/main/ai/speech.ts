// OpenAI-compatible speech-to-text and text-to-speech (ffmpeg for format conversion).

import { spawn } from 'node:child_process';
import { accessSync, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Settings } from '../../shared/types';
import { ensureMediaDir } from '../media';
import { recordUsage } from '../usage';

const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_DELAYS_MS = [500, 2000];
const MAX_STT_BYTES = 24 * 1024 * 1024;
const CHUNK_SEC = 600;
const TTS_INSTRUCTIONS =
  'Говори естественно и дружелюбно, как помощник, в умеренном темпе';

const ATTRIBUTION = {
  'HTTP-Referer': 'https://github.com/VKirill/tg-search',
  'X-Title': 'TG Search',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryAfterMs(res: Response): number | null {
  const h = res.headers.get('Retry-After');
  if (!h) return null;
  const n = Number(h);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const d = Date.parse(h);
  if (!Number.isNaN(d)) return Math.max(0, d - Date.now());
  return null;
}

function isRetryableHttp(status: number): boolean {
  return status === 429 || status >= 500;
}

export function resolveFfmpegBin(name: 'ffmpeg' | 'ffprobe'): string {
  const env = name === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (env?.trim()) return env.trim();
  const file = name === 'ffmpeg' ? 'ffmpeg' : 'ffprobe';
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin']) {
    const path = join(dir, file);
    try {
      accessSync(path);
      return path;
    } catch {
      /* try next */
    }
  }
  return file;
}

export async function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(resolveFfmpegBin('ffmpeg'), ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('close', (code) => resolve(code === 0));
  });
}

function ffmpegMissingError(): Error {
  return new Error('Не найден ffmpeg — установите: brew install ffmpeg');
}

async function runProcess(bin: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr?.on('data', (c) => {
      err += String(c);
    });
    p.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') reject(ffmpegMissingError());
      else reject(e);
    });
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.trim() || `${bin} exited ${code}`));
    });
  });
}

export async function probeDurationSec(filePath: string): Promise<number> {
  const ffprobe = resolveFfmpegBin('ffprobe');
  const out: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const p = spawn(
      ffprobe,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    p.stdout?.on('data', (c) => out.push(String(c)));
    p.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') reject(ffmpegMissingError());
      else reject(e);
    });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ffprobe failed'))));
  });
  const sec = Number(out.join('').trim());
  if (!Number.isFinite(sec) || sec <= 0) return 1;
  return sec;
}

export async function convertToTelegramVoice(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = resolveFfmpegBin('ffmpeg');
  await runProcess(ffmpeg, [
    '-y',
    '-i',
    inputPath,
    '-c:a',
    'libopus',
    '-b:a',
    '32k',
    '-ac',
    '1',
    '-ar',
    '48000',
    outputPath,
  ]);
}

export async function convertToSttAudio(inputPath: string, outputPath: string): Promise<void> {
  const ffmpeg = resolveFfmpegBin('ffmpeg');
  await runProcess(ffmpeg, [
    '-y',
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libopus',
    outputPath,
  ]);
}

async function splitAudioChunks(inputPath: string, workDir: string): Promise<string[]> {
  const ffmpeg = resolveFfmpegBin('ffmpeg');
  const pattern = join(workDir, 'chunk_%03d.ogg');
  await runProcess(ffmpeg, [
    '-y',
    '-i',
    inputPath,
    '-f',
    'segment',
    '-segment_time',
    String(CHUNK_SEC),
    '-reset_timestamps',
    '1',
    '-c:a',
    'libopus',
    pattern,
  ]);
  const { readdir } = await import('node:fs/promises');
  const names = await readdir(workDir);
  return names
    .filter((n) => n.startsWith('chunk_') && n.endsWith('.ogg'))
    .sort()
    .map((n) => join(workDir, n));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) {
        const excerpt = (await res.text()).slice(0, 200).replace(/\s+/g, ' ').trim();
        const err = new Error(
          `Ошибка ${label}: HTTP ${res.status}${excerpt ? ` — ${excerpt}` : ''}`,
        ) as Error & { status?: number; retryAfterMs?: number | null };
        err.status = res.status;
        err.retryAfterMs = retryAfterMs(res);
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number }).status;
      const retryable =
        status !== undefined
          ? isRetryableHttp(status)
          : e instanceof TypeError || (e as Error).name === 'TimeoutError';
      if (!retryable || attempt >= RETRY_DELAYS_MS.length) break;
      const after = (e as { retryAfterMs?: number | null }).retryAfterMs;
      const delay = after != null && after > 0 ? after : RETRY_DELAYS_MS[attempt];
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface SpeechService {
  transcribe(filePath: string): Promise<string>;
  synthesize(text: string): Promise<{ path: string; durationSec: number }>;
  prepareForStt(inputPath: string): Promise<{ path: string; cleanup: () => Promise<void> }>;
}

export class OpenAiSpeech implements SpeechService {
  constructor(
    private readonly settings: () => Settings,
    private readonly dataDir: string,
  ) {}

  private sttSettings(): Settings {
    const s = this.settings();
    const key = s.sttApiKey.trim();
    if (!key) throw new Error('Укажите ключ распознавания речи в настройках');
    return {
      ...s,
      sttModel: s.sttModel.trim() || 'whisper-large-v3-turbo',
      sttBaseUrl: s.sttBaseUrl.trim() || 'https://api.groq.com/openai/v1',
    };
  }

  private ttsSettings(): Settings {
    const s = this.settings();
    const key = s.ttsApiKey.trim();
    if (!key) throw new Error('Укажите ключ синтеза речи в настройках');
    return {
      ...s,
      ttsModel: s.ttsModel.trim() || 'gpt-4o-mini-tts',
      ttsVoice: s.ttsVoice.trim() || 'nova',
      ttsBaseUrl: s.ttsBaseUrl.trim() || 'https://api.openai.com/v1',
    };
  }

  async transcribe(filePath: string): Promise<string> {
    const s = this.sttSettings();
    recordUsage({ kind: 'stt', model: s.sttModel, units: await probeDurationSec(filePath).catch(() => 0) });
    const st = await stat(filePath);
    if (st.size <= MAX_STT_BYTES) {
      return this.transcribeOne(filePath);
    }
    const workDir = await mkdtemp(join(tmpdir(), 'tg-stt-'));
    try {
      const chunks = await splitAudioChunks(filePath, workDir);
      const parts: string[] = [];
      for (const chunk of chunks) {
        parts.push(await this.transcribeOne(chunk));
      }
      return parts.join(' ').trim();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  private async transcribeOne(filePath: string): Promise<string> {
    const s = this.sttSettings();
    const url = `${s.sttBaseUrl.replace(/\/$/, '')}/audio/transcriptions`;
    const buf = await readFile(filePath);
    const form = new FormData();
    // Telegram voice notes are Ogg Opus saved as .oga; Whisper APIs judge the format by extension and reject «oga»
    form.append('file', new Blob([buf]), basename(filePath).replace(/\.(oga|opus)$/i, '.ogg'));
    form.append('model', s.sttModel);
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.sttApiKey}`, ...ATTRIBUTION },
        body: form,
      },
      'распознавания речи',
    );
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim() ?? '';
    if (!text) throw new Error('Ошибка распознавания речи: пустой ответ');
    return text;
  }

  async synthesize(text: string): Promise<{ path: string; durationSec: number }> {
    const s = this.ttsSettings();
    const url = `${s.ttsBaseUrl.replace(/\/$/, '')}/audio/speech`;
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.ttsApiKey}`,
          'Content-Type': 'application/json',
          ...ATTRIBUTION,
        },
        body: JSON.stringify({
          model: s.ttsModel,
          voice: s.ttsVoice,
          input: text,
          instructions: TTS_INSTRUCTIONS,
        }),
      },
      'синтеза речи',
    );
    const workDir = await mkdtemp(join(tmpdir(), 'tg-tts-'));
    const rawPath = join(workDir, 'raw.bin');
    try {
      const body = res.body;
      if (!body) throw new Error('Ошибка синтеза речи: пустой ответ');
      await pipeline(Readable.fromWeb(body as import('stream/web').ReadableStream), createWriteStream(rawPath));
      const outDir = ensureMediaDir(this.dataDir);
      const oggPath = join(outDir, `tts-${Date.now()}.ogg`);
      await convertToTelegramVoice(rawPath, oggPath);
      const durationSec = await probeDurationSec(oggPath);
      recordUsage({ kind: 'tts', model: s.ttsModel, units: durationSec });
      return { path: oggPath, durationSec };
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /** Mono 16 kHz Opus for STT (call recordings and other non-Telegram audio). */
  async prepareForStt(inputPath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    const workDir = await mkdtemp(join(tmpdir(), 'tg-stt-prep-'));
    const out = join(workDir, 'stt.ogg');
    await convertToSttAudio(inputPath, out);
    return { path: out, cleanup: () => rm(workDir, { recursive: true, force: true }) };
  }
}

/** Generate a short sine wave WAV for tests (no ffmpeg needed to create). */
export async function writeTestWav(filePath: string, durationSec = 2, sampleRate = 44100): Promise<void> {
  const n = Math.floor(durationSec * sampleRate);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 0.3;
    buf.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  await writeFile(filePath, buf);
}

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAiSpeech,
  convertToTelegramVoice,
  ffmpegAvailable,
  probeDurationSec,
  writeTestWav,
} from '../src/main/ai/speech';
import type { Settings } from '../src/shared/types';

const baseSettings = (): Settings => ({
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  jevBaseUrl: '',
  jevApiKey: '',
  jevModel: '',
  handoffNotifyTo: '',
  ownerName: 'Кирилл',
  sttBaseUrl: 'https://api.openai.com/v1',
  sttApiKey: 'stt-key',
  sttModel: 'gpt-4o-transcribe',
  ttsBaseUrl: 'https://api.openai.com/v1',
  ttsApiKey: 'tts-key',
  ttsModel: 'gpt-4o-mini-tts',
  ttsVoice: 'nova', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', newsInterests: '', operatorProvider: 'glm', glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '', geminiApiKey: '', aiProviders: '[]', aiMainModel: '', aiHelperModels: '[]', aiUseFree: '1', aiVerifierModel: '', helperChats: '[]', helperDailyPerUser: '5',
});

describe('OpenAiSpeech HTTP', () => {
  afterEach(() => vi.restoreAllMocks());

  it('posts multipart transcription with model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-speech-'));
    const wav = join(dir, 'a.wav');
    await writeTestWav(wav, 0.1);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ text: 'привет' }),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const speech = new OpenAiSpeech(baseSettings, dir);
    const text = await speech.transcribe(wav);
    expect(text).toBe('привет');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer stt-key');
    expect(init.body).toBeInstanceOf(FormData);
    await rm(dir, { recursive: true, force: true });
  });

  it('sends a Telegram .oga voice note as .ogg (Whisper APIs reject the «oga» extension)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'stt-oga-'));
    const oga = join(dir, 'voice-1.oga');
    await writeTestWav(oga, 0.1);
    const fetchMock = vi.fn(async () => ({
      ok: true, status: 200, headers: new Headers(), json: async () => ({ text: 'ок' }), text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAiSpeech(baseSettings, dir).transcribe(oga);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(((init.body as FormData).get('file') as File).name).toBe('voice-1.ogg');
    await rm(dir, { recursive: true, force: true });
  });

  it('posts JSON speech with voice and instructions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-speech-'));
    const rawWav = join(dir, 'speech.wav');
    await writeTestWav(rawWav, 0.5);
    const wavBytes = await readFile(rawWav);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(wavBytes);
          controller.close();
        },
      }),
      json: async () => ({}),
      text: async () => '',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) {
      await expect(new OpenAiSpeech(baseSettings, dir).synthesize('текст')).rejects.toThrow('ffmpeg');
      await rm(dir, { recursive: true, force: true });
      return;
    }

    const speech = new OpenAiSpeech(baseSettings, dir);
    const { path, durationSec } = await speech.synthesize('текст');
    expect(durationSec).toBeGreaterThan(0);
    const buf = await readFile(path);
    expect(buf.length).toBeGreaterThan(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/audio/speech');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('gpt-4o-mini-tts');
    expect(body.voice).toBe('nova');
    expect(body.input).toBe('текст');
    expect(body.instructions).toContain('дружелюбно');
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects missing stt key in Russian', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tg-speech-'));
    const speech = new OpenAiSpeech(() => ({ ...baseSettings(), sttApiKey: '' }), dir);
    await expect(speech.transcribe(join(dir, 'x.wav'))).rejects.toThrow('ключ распознавания речи');
    await rm(dir, { recursive: true, force: true });
  });
});

describe('ffmpeg conversion', () => {
  it('converts sine wav to telegram ogg and reads duration', async () => {
    const hasFfmpeg = await ffmpegAvailable();
    if (!hasFfmpeg) return;

    const dir = await mkdtemp(join(tmpdir(), 'tg-ffmpeg-'));
    const wav = join(dir, 'tone.wav');
    const ogg = join(dir, 'out.ogg');
    await writeTestWav(wav, 2);
    await convertToTelegramVoice(wav, ogg);
    const dur = await probeDurationSec(ogg);
    expect(dur).toBeGreaterThan(1.5);
    expect(dur).toBeLessThan(2.5);
    await rm(dir, { recursive: true, force: true });
  });
});

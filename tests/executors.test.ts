import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as llm from '../src/main/ai/llm';
import { falRunImageJob } from '../src/main/executors/images';
import { createHomeworkExecutor } from '../src/main/executors/homework';
import { createCopywritingExecutor } from '../src/main/executors/copywriting';
import { createMarketplaceCardExecutor } from '../src/main/executors/marketplace_card';
import { imageGenReferencePaths, createImageGenExecutor } from '../src/main/executors/image_gen';
import { clampPrice, estimatePrice } from '../src/main/executors/shared';
import type { Lead, Order, Service, Settings } from '../src/shared/types';
import type { ExecutorInput } from '../src/main/executors/types';
import { SETTINGS_DEFAULTS } from '../src/main/db';
import * as shared from '../src/main/executors/shared';
import * as images from '../src/main/executors/images';

const baseSettings = (): Settings => ({
  ...SETTINGS_DEFAULTS,
  llmApiKey: 'sk-test',
  falKey: 'fal-test',
});

function sampleService(over: Partial<Service> = {}): Service {
  return {
    id: 1,
    kind: 'homework',
    name: 'Тест',
    categoryId: null,
    enabled: true,
    priceMin: 300,
    priceMax: 1500,
    instructions: 'Инструкция для оценки',
    model: '',
    previewEnabled: true,
    revisions: 1,
    ...over,
  };
}

function sampleInput(over: Partial<ExecutorInput> = {}): ExecutorInput {
  const service = over.service ?? sampleService();
  return {
    service,
    order: {
      id: 1,
      leadId: 1,
      serviceId: 1,
      status: 'paid',
      price: 500,
      brief: 'Тестовый бриф',
      files: [],
      paymentId: null,
      paymentUrl: null,
      paidAt: null,
      result: null,
      revisionsUsed: 0,
      error: null,
      createdAt: 0,
      updatedAt: 0,
      ...(over.order as Partial<Order>),
    },
    lead: {
      id: 1,
      projectId: 1,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 1,
      authorName: 'A',
      authorUsername: null,
      text: 'hi',
      date: 0,
      link: null,
      score: 80,
      label: 'demand',
      reason: '',
      feedback: null,
      status: 'new',
      accountId: 1,
      clientId: null,
      sequenceStep: 0,
      nextStepAt: null,
      handoff: false,
      handoffReason: null,
      createdAt: 0,
      ...(over.lead as Partial<Lead>),
    },
    history: [],
    inputs: [],
    workDir: '/tmp/work',
    clientPhotoPath: null,
    ...over,
  };
}

describe('clampPrice / estimate', () => {
  it('clamps price to service range', () => {
    const s = sampleService({ priceMin: 300, priceMax: 1500 });
    expect(clampPrice(s, 100)).toBe(300);
    expect(clampPrice(s, 2000)).toBe(1500);
    expect(clampPrice(s, 800)).toBe(800);
  });

  it('estimate clamps LLM price', async () => {
    vi.spyOn(llm, 'chatJsonCompletion').mockResolvedValue({ price: 99999, reason: 'сложно' });
    const r = await estimatePrice(baseSettings, sampleInput());
    expect(r.price).toBe(1500);
    expect(r.reason).toBe('сложно');
  });
});

describe('homework executor', () => {
  afterEach(() => vi.restoreAllMocks());

  it('throws when verification disagrees after re-solve', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'hw-'));
    const photo = join(workDir, 'task.png');
    await writeFile(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const vision = vi.fn()
      .mockResolvedValueOnce('Решение A\nОтвет: 1')
      .mockResolvedValueOnce('Решение B\nОтвет: 2')
      .mockResolvedValueOnce('Решение C\nОтвет: 3')
      .mockResolvedValueOnce('{"agree": false, "summary": "разные ответы"}')
      .mockResolvedValueOnce('{"agree": false, "summary": "всё ещё разные"}');

    vi.spyOn(shared, 'visionChat').mockImplementation(vision);

    const ex = createHomeworkExecutor(baseSettings);
    await expect(
      ex.run(
        sampleInput({
          workDir,
          inputs: [{ path: photo, role: 'input', name: 'task.png', mime: 'image/png' }],
        }),
      ),
    ).rejects.toThrow(/Нужна проверка человеком/);
  });

  it('preview is not offered', async () => {
    const ex = createHomeworkExecutor(baseSettings);
    await expect(ex.preview(sampleInput())).rejects.toThrow('Превью не предусмотрено');
  });
});

describe('marketplace_card', () => {
  afterEach(() => vi.restoreAllMocks());

  it('mentions WB rules in content prompt', async () => {
    const spy = vi.spyOn(llm, 'chatCompletion').mockResolvedValue(
      JSON.stringify({
        title: 'T',
        description: 'D',
        characteristics: [],
        keywords: [],
        slideCount: 1,
        slidePrompts: ['slide'],
      }),
    );
    vi.spyOn(images, 'generateImages').mockResolvedValue([]);

    const ex = createMarketplaceCardExecutor(baseSettings);
    await ex.preview(sampleInput({ service: sampleService({ kind: 'marketplace_card' }) }));

    const system = spy.mock.calls[0][1][0].content;
    expect(system).toMatch(/Wildberries|WB|QR/i);
    expect(system).toMatch(/цен/i);
  });
});

describe('image_gen', () => {
  it('never includes client avatar path when null', () => {
    const input = sampleInput({
      clientPhotoPath: null,
      inputs: [{ path: '/in/face.png', role: 'input', name: 'f.png', mime: 'image/png' }],
    });
    expect(imageGenReferencePaths(input)).toEqual(['/in/face.png']);
    expect(imageGenReferencePaths(sampleInput({ clientPhotoPath: null, inputs: [] }))).toEqual([]);
  });

  it('includes client avatar when consented', () => {
    const input = sampleInput({ clientPhotoPath: '/avatar.jpg', inputs: [] });
    expect(imageGenReferencePaths(input)).toEqual(['/avatar.jpg']);
  });
});

describe('copywriting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves long result to markdown file', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'copy-'));
    const long = 'а'.repeat(3600);
    vi.spyOn(llm, 'chatCompletion').mockResolvedValue(long);
    vi.spyOn(images, 'generateImages').mockResolvedValue([]);

    const ex = createCopywritingExecutor(baseSettings);
    const out = await ex.run(
      sampleInput({
        workDir,
        service: sampleService({ kind: 'copywriting' }),
        order: { ...sampleInput().order, brief: 'контент-план на неделю' },
      }),
    );

    expect(out.files.some((f) => f.mime === 'text/markdown' && f.role === 'output')).toBe(true);
  });
});

describe('falRunImageJob', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

  afterEach(() => vi.restoreAllMocks());

  it('polls queue and downloads images', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'fal-'));
    let statusCalls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('queue.fal.run/fal-ai/test') && !url.includes('/status') && !url.includes('/requests/')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              request_id: 'req-1',
              status_url: 'https://queue.fal.run/fal-ai/test/requests/req-1/status',
              response_url: 'https://queue.fal.run/fal-ai/test/requests/req-1',
            }),
            text: async () => '',
          } as Response;
        }
        if (url.includes('/status')) {
          statusCalls++;
          return {
            ok: true,
            status: 200,
            json: async () =>
              statusCalls >= 2
                ? { status: 'COMPLETED', response_url: 'https://queue.fal.run/fal-ai/test/requests/req-1' }
                : { status: 'IN_QUEUE', response_url: 'https://queue.fal.run/fal-ai/test/requests/req-1' },
            text: async () => '',
          } as Response;
        }
        if (url.includes('queue.fal.run/fal-ai/test/requests/req-1')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ images: [{ url: 'https://cdn.example/out.png', content_type: 'image/png' }] }),
            text: async () => '',
          } as Response;
        }
        if (url === 'https://cdn.example/out.png') {
          return {
            ok: true,
            status: 200,
            arrayBuffer: async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
            text: async () => '',
          } as Response;
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    const files = await falRunImageJob(baseSettings(), 'fal-ai/test', { prompt: 'x' }, workDir, 'img');
    expect(files).toHaveLength(1);
    expect(files[0].mime).toBe('image/png');
    expect(files[0].path).toContain(workDir);
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });
});

describe('image_gen run without client photo', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not send client photo in fal body when null', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'igen-'));
    const genSpy = vi.spyOn(images, 'generateImages').mockResolvedValue([
      { path: join(workDir, 'image-1.png'), role: 'output', name: 'image-1.png', mime: 'image/png' },
    ]);
    vi.spyOn(llm, 'chatCompletion').mockResolvedValue('portrait prompt');

    const ex = createImageGenExecutor(baseSettings);
    await ex.run(
      sampleInput({
        workDir,
        clientPhotoPath: null,
        service: sampleService({ kind: 'image_gen' }),
      }),
    );

    expect(genSpy.mock.calls[0][2].referencePaths).toBeUndefined();
  });
});

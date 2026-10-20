import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TdlEngine } from '../src/main/telegram/engine';

const emptySettings = () => ({
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
});

describe('TdlEngine smoke', () => {
  it('init with no accounts and close', async () => {
    const dataDir = join(import.meta.dirname, '../tmp/tdlib-vitest');
    mkdirSync(dataDir, { recursive: true });
    const engine = new TdlEngine(dataDir, emptySettings);
    await engine.init([]);
    await engine.close();
  });

  it('startLogin without api settings throws in Russian', async () => {
    const dataDir = join(import.meta.dirname, '../tmp/tdlib-vitest');
    const engine = new TdlEngine(dataDir, emptySettings);
    await expect(engine.startLogin(1, '+10000000000')).rejects.toThrow(/api_id/);
  });
});

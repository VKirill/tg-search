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
  jevBaseUrl: '',
  jevApiKey: '',
  jevModel: '', handoffNotifyTo: '', ownerName: 'Кирилл', sttBaseUrl: '', sttApiKey: '', sttModel: '', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '',
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

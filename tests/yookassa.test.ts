import { afterEach, describe, expect, it, vi } from 'vitest';
import { YooKassaProvider } from '../src/main/payments/yookassa';

const settings = () => ({
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
  sttBaseUrl: '',
  sttApiKey: '',
  sttModel: '',
  ttsBaseUrl: '',
  ttsApiKey: '',
  ttsModel: '',
  ttsVoice: '',
  jevPricePerMTok: '0.042',
  sttPricePerMin: '0.006',
  ttsPricePerMin: '0.015', imagePricePerImage: '0.04',
  requestThreshold: '0.2',
  yookassaShopId: 'shop',
  yookassaSecretKey: 'secret',
  yookassaReturnUrl: 'https://t.me/test',
  auxBaseUrl: '',
  auxApiKey: '',
  auxModel: '',
  falKey: '',
  imageModel: '',
});

describe('YooKassaProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('requires credentials', async () => {
    const p = new YooKassaProvider(() => ({ ...settings(), yookassaShopId: '', yookassaSecretKey: '' }));
    await expect(p.create(1, 100, 'test', 'https://t.me')).rejects.toThrow('Укажите shopId');
  });

  it('creates payment with idempotence key', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'pay-1', confirmation: { confirmation_url: 'https://yoomoney.ru/checkout' } }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new YooKassaProvider(settings);
    const r = await p.create(5, 500, 'Описание', 'https://t.me/back');
    expect(r).toEqual({ id: 'pay-1', url: 'https://yoomoney.ru/checkout' });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init?.headers).toMatchObject({ 'Idempotence-Key': 'order-5-500' });
    const body = JSON.parse(String(init?.body));
    expect(body.amount).toEqual({ value: '500.00', currency: 'RUB' });
    expect(body.metadata.orderId).toBe('5');
  });

  it('maps HTTP errors to Russian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ description: 'Invalid amount' }),
      })),
    );
    const p = new YooKassaProvider(settings);
    await expect(p.status('x')).rejects.toThrow('400: Invalid amount');
  });

  it('reads payment status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ status: 'pending' }),
      })),
    );
    const p = new YooKassaProvider(settings);
    await expect(p.status('pay-1')).resolves.toBe('pending');
  });
});

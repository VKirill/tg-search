import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevQualifier } from '../src/main/ai/jev';
import { DEFAULT_AUTOPILOT, type Project, type Settings, DEFAULT_MANAGER } from '../src/shared/types';
import type { TgMessage } from '../src/main/telegram/types';

const settings = (): Settings => ({
  tgApiId: '',
  tgApiHash: '',
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
  jevBaseUrl: 'https://api.openlux.ai/v1',
  jevApiKey: 'test-key',
  jevModel: 'jev-1.14.0', handoffNotifyTo: '', ownerName: 'Кирилл', sttBaseUrl: '', sttApiKey: '', sttModel: '', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', newsInterests: '', operatorProvider: 'glm', glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '', geminiApiKey: '', aiProviders: '[]', aiMainModel: '', aiHelperModels: '[]', aiUseFree: '1',
});

const project = (): Project => ({
  id: 1,
  name: 'P',
  task: 'clients',
  target: 'бизнес',
  offer: 'разработка',
  criteria: 'Ищем заказчиков',
  sequence: [],
  manager: DEFAULT_MANAGER,
  geo: [],
  languages: ['ru'],
  accountIds: [],
  materials: [],
  keywords: [],
  agent: '',
  autopilot: DEFAULT_AUTOPILOT,
  createdAt: 0,
});

function msg(id: number, text: string): TgMessage {
  return {
    chatId: 10,
    messageId: id,
    date: 0,
    text,
    senderUserId: 1,
    senderChatId: null,
    senderName: 'A',
    senderUsername: 'a',
    senderIsBot: false,
    voice: null,
    photo: null,
    document: null,
    replyToMessageId: null,
    link: null,
    isOutgoing: false,
  };
}

function scoreAnswer(p0: number, p1: number, p2: number) {
  return {
    type: 'score',
    score: p2,
    confidence: 0.9,
    legend: { '0': '', '1': '', '2': '' },
    probabilities: { '0': p0, '1': p1, '2': p2 },
  };
}

function noulAnswer(n: number) {
  return { type: 'noul', noul: n };
}

describe('JevQualifier', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws without API key', async () => {
    const q = new JevQualifier(() => ({ ...settings(), jevApiKey: '' }));
    await expect(q.qualify(project(), [msg(1, 'нужен сайт под ключ')], [])).rejects.toThrow(
      'Укажите ключ Jev в настройках',
    );
  });

  it('sends expected request shape for one message', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        answers: {
          fit_0: scoreAnswer(0.03, 0.01, 0.96),
          seller_0: noulAnswer(0.04),
        },
      }),
    } as Response);

    const q = new JevQualifier(settings);
    await q.qualify(project(), [msg(1, 'ищу разработчика сайта')], [{ text: 'пример', verdict: 'up' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init?.method).toBe('POST');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toBe('https://api.openlux.ai/v1/systemone');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('jev-1.14.0');
    expect(body.state.project.criteria).toBe('Ищем заказчиков');
    expect(body.state.messages).toHaveLength(1);
    expect(body.questions.fit_0.type).toBe('score');
    expect(body.questions.seller_0.type).toBe('noul');
    expect(body.state.feedback[0].verdict).toBe('relevant');
  });

  it('chunks 25 messages into 3 requests', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ answers: {} }),
    } as Response));

    const messages = Array.from({ length: 25 }, (_, i) => msg(i + 1, `сообщение номер ${i + 1} длинное`));
    const q = new JevQualifier(settings);
    await q.qualify(project(), messages, []);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const sizes = fetchMock.mock.calls.map((c) => {
      const b = JSON.parse(String((c[1] as RequestInit).body));
      return b.state.messages.length;
    });
    expect(sizes.sort((a, b) => a - b)).toEqual([5, 10, 10]);
  });

  it('maps demand score and seller cap', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        answers: {
          fit_0: scoreAnswer(0.05, 0.1, 0.85),
          seller_0: noulAnswer(0.04),
        },
      }),
    } as Response);

    const q = new JevQualifier(settings);
    const [r] = await q.qualify(project(), [msg(1, 'нужен лендинг срочно')], []);
    expect(r.label).toBe('demand');
    expect(r.score).toBe(90);
    expect(r.reason).toContain('продавец 4%');
  });

  it('caps score when seller is high', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({
        answers: {
          fit_0: scoreAnswer(0.05, 0.1, 0.85),
          seller_0: noulAnswer(0.8),
        },
      }),
    } as Response);

    const q = new JevQualifier(settings);
    const [r] = await q.qualify(project(), [msg(1, 'делаю сайты под ключ')], []);
    expect(r.label).toBe('irrelevant');
    expect(r.score).toBeLessThanOrEqual(20);
  });

  it('missing answers → нет оценки', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ answers: {} }),
    } as Response);

    const q = new JevQualifier(settings);
    const [r] = await q.qualify(project(), [msg(1, 'текст сообщения')], []);
    expect(r.score).toBe(0);
    expect(r.reason).toBe('нет оценки');
  });

  it('retries on 429 then succeeds', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '0' }),
        text: async () => 'rate limit',
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          answers: {
            fit_0: scoreAnswer(0, 0, 1),
            seller_0: noulAnswer(0),
          },
        }),
      } as Response);

    const q = new JevQualifier(settings);
    const [r] = await q.qualify(project(), [msg(1, 'нужен бот в телеграм')], []);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(r.label).toBe('demand');
  });
});

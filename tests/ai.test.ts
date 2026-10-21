import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiLeadAi } from '../src/main/ai/leadAi';
import { chatCompletion, parseJsonFromLlm } from '../src/main/ai/llm';
import { LlmSpinner } from '../src/main/ai/spinner';
import { DEFAULT_AUTOPILOT, type Lead, type Project, type Settings, DEFAULT_MANAGER } from '../src/shared/types';
import type { TgMessage } from '../src/main/telegram/types';

const baseSettings = (): Settings => ({
  tgApiId: '1',
  tgApiHash: 'hash',
  llmBaseUrl: 'https://openrouter.ai/api/v1',
  llmApiKey: 'sk-test',
  llmModel: 'anthropic/claude-haiku-5.5',
  jevBaseUrl: '',
  jevApiKey: '',
  jevModel: '', handoffNotifyTo: '', ownerName: 'Кирилл', sttBaseUrl: '', sttApiKey: '', sttModel: '', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', newsInterests: '', operatorProvider: 'glm', glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '', geminiApiKey: '', aiProviders: '[]', aiMainModel: '', aiHelperModels: '[]', aiUseFree: '1',
});

function completionBody(content: string) {
  return {
    choices: [{ message: { content } }],
  };
}

function mockFetchJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      text: async () => JSON.stringify(body),
      json: async () => body,
    } as Response;
  });
}

const sampleProject = (): Project => ({
  id: 1,
  name: 'Тест',
  task: 'clients',
  target: 'стартапы',
  offer: 'разработка на TypeScript',
  criteria: '',
  sequence: [],
  manager: DEFAULT_MANAGER,
  geo: ['Россия'],
  languages: ['русский'],
  accountIds: [1],
  materials: [],
  keywords: [],
  agent: '',
  autopilot: DEFAULT_AUTOPILOT,
  createdAt: 0,
});

function tgMessage(chatId: number, messageId: number, text: string): TgMessage {
  return {
    chatId,
    messageId,
    date: 0,
    text,
    senderUserId: 1,
    senderChatId: null,
    senderName: 'U',
    senderUsername: null,
    senderIsBot: false,
    voice: null,
    photo: null,
    document: null,
    replyToMessageId: null,
    link: null,
    isOutgoing: false,
  };
}

describe('parseJsonFromLlm', () => {
  it('strips markdown fences and parses object', () => {
    const raw = '```json\n{"a":1}\n```';
    expect(parseJsonFromLlm(raw)).toEqual({ a: 1 });
  });

  it('takes first braced block from noisy text', () => {
    const raw = 'note {"score": 90, "reason": "ok"} trailing';
    expect(parseJsonFromLlm(raw)).toEqual({ score: 90, reason: 'ok' });
  });
});

describe('chatCompletion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends OpenRouter attribution and json response_format', async () => {
    const fetchMock = mockFetchJson(completionBody('{"keywords":["ищу бота"]}'));
    vi.stubGlobal('fetch', fetchMock);

    await chatCompletion(baseSettings, [{ role: 'user', content: 'hi' }], { jsonObject: true });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    expect(headers['HTTP-Referer']).toBe('https://github.com/VKirill/tg-search');
    expect(headers['X-Title']).toBe('TG Search');
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('anthropic/claude-haiku-5.5');
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.temperature).toBe(0.2);
  });

  it('throws Russian message when API key is empty', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const settings = () => ({ ...baseSettings(), llmApiKey: '  ' });
    await expect(chatCompletion(settings, [{ role: 'user', content: 'x' }])).rejects.toThrow(
      'Укажите ключ LLM в настройках',
    );
  });

  it('retries on 429 then succeeds', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: new Headers(),
            text: async () => 'rate limited',
          } as Response;
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => JSON.stringify(completionBody('ok')),
          json: async () => completionBody('ok'),
        } as Response;
      }),
    );

    const text = await chatCompletion(baseSettings, [{ role: 'user', content: 'x' }]);
    expect(text).toBe('ok');
    expect(calls).toBe(2);
  });
});

describe('OpenAiLeadAi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('qualify chunks 45 messages into 3 LLM calls', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () =>
        completionBody(
          JSON.stringify({
            items: Array.from({ length: 20 }, (_, i) => ({
              key: `1:${i + 1}`,
              score: 50,
              label: 'interest',
              reason: 'тест',
            })),
          }),
        ),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const ai = new OpenAiLeadAi(baseSettings);
    const messages = Array.from({ length: 45 }, (_, i) => tgMessage(1, i + 1, `msg ${i}`));
    const out = await ai.qualify(sampleProject(), messages, []);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(out).toHaveLength(45);
  });

  it('fills missing qualify items with score 0', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson(
        completionBody(
          JSON.stringify({
            items: [{ key: '1:1', score: 80, label: 'demand', reason: 'запрос' }],
          }),
        ),
      ),
    );
    const ai = new OpenAiLeadAi(baseSettings);
    const out = await ai.qualify(sampleProject(), [tgMessage(1, 1, 'ищу'), tgMessage(1, 2, 'другое')], []);
    expect(out[1]).toMatchObject({ key: '1:2', score: 0, label: 'irrelevant', reason: 'нет оценки' });
  });

  it('normalises invalid qualify labels to irrelevant', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetchJson(
        completionBody(
          JSON.stringify({
            items: [{ key: '1:1', score: 70, label: 'COMPETITOR', reason: 'нет' }],
          }),
        ),
      ),
    );
    const ai = new OpenAiLeadAi(baseSettings);
    const out = await ai.qualify(sampleProject(), [tgMessage(1, 1, 'текст')], []);
    expect(out[0].label).toBe('irrelevant');
  });

  it('draftReply uses higher temperature', async () => {
    const fetchMock = mockFetchJson(completionBody(JSON.stringify({ text: 'Привет' })));
    vi.stubGlobal('fetch', fetchMock);
    const ai = new OpenAiLeadAi(baseSettings);
    const lead: Lead = {
      id: 1,
      projectId: 1,
      sourceId: null,
      tgChatId: 1,
      tgMessageId: 1,
      authorUserId: 2,
      authorName: 'A',
      authorUsername: null,
      text: 'нужен бот',
      date: 0,
      link: null,
      score: 90,
      label: 'demand',
      reason: '',
      feedback: null,
      status: 'new',
      accountId: null,
      clientId: null,
      repeatCount: 0,
      spamTemplateId: null,
      categoryId: null,
      sequenceStep: 0,
      nextStepAt: null,
      handoff: false,
      handoffReason: null,
      createdAt: 0,
    };
    await ai.draftReply(sampleProject(), lead, 'dm', []);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1]?.body));
    expect(body.temperature).toBe(0.6);
  });

  it('retries JSON parse once on fenced invalid then valid response', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n++;
        const content =
          n === 1 ? 'not json' : JSON.stringify({ keywords: ['ищу сайт', 'ищу сайт', 'нужен бот'] });
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => completionBody(content),
        } as Response;
      }),
    );
    const ai = new OpenAiLeadAi(baseSettings);
    const words = await ai.suggestKeywords({
      task: 'clients',
      target: 'бизнес',
      offer: 'сайты',
      geo: [],
      languages: ['русский'],
      materials: [],
    });
    expect(n).toBe(2);
    expect(words).toEqual(['ищу сайт', 'нужен бот']);
  });
});

describe('LlmSpinner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns spun text from JSON response', async () => {
    vi.stubGlobal('fetch', mockFetchJson(completionBody('{"text":"Вариант текста"}')));
    const spinner = new LlmSpinner(baseSettings);
    await expect(spinner.spin('Исходный текст @shop 100₽')).resolves.toBe('Вариант текста');
  });

  it('throws on invalid JSON shape', async () => {
    vi.stubGlobal('fetch', mockFetchJson(completionBody('{"oops":1}')));
    const spinner = new LlmSpinner(baseSettings);
    await expect(spinner.spin('x')).rejects.toThrow('неверный формат text');
  });
});

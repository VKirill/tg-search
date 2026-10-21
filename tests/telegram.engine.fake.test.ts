// TdlEngine against a fake TDLib client: send confirmation timing and history paging.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

type Handler = (u: any) => void;

const fake = vi.hoisted(() => ({
  client: null as any,
  history: [] as any[], // newest first, like TDLib
}));

vi.mock('tdl', () => ({
  configure: () => {},
  createClient: () => {
    const handlers: Handler[] = [];
    const msg = (id: number, text: string) => ({
      _: 'message', id, chat_id: -100, date: 1_800_000_000 + id, is_outgoing: false,
      sender_id: { _: 'messageSenderUser', user_id: 7 },
      content: { _: 'messageText', text: { _: 'formattedText', text, entities: [] } },
    });
    fake.client = {
      on: (event: string, h: Handler) => event === 'update' && handlers.push(h),
      close: async () => {},
      invoke: async (q: any) => {
        switch (q._) {
          case 'getAuthorizationState':
            return { _: 'authorizationStateReady' };
          case 'getChat':
            return q.chat_id === 7
              ? { _: 'chat', id: 7, title: 'User', type: { _: 'chatTypePrivate', user_id: 7 } }
              : { _: 'chat', id: -100, title: 'Group', type: { _: 'chatTypeBasicGroup', basic_group_id: 1 } };
          case 'getUser':
            return { _: 'user', id: 7, first_name: 'Ann', last_name: '', usernames: null, type: { _: 'userTypeRegular' } };
          case 'createPrivateChat':
            return { _: 'chat', id: 7, title: 'User', type: { _: 'chatTypePrivate', user_id: 7 } };
          case 'sendMessage': {
            // TDLib may deliver the confirmation before the sendMessage response is handled.
            const final = { ...msg(500, 'hi'), chat_id: q.chat_id, is_outgoing: true };
            handlers.forEach((h) => h({ _: 'updateMessageSendSucceeded', old_message_id: 1, message: final }));
            return { ...final, id: 1 };
          }
          case 'getChatHistory': {
            // offset 0 includes from_message_id itself; TDLib returns small pages.
            const from = q.from_message_id || Infinity;
            const page = fake.history.filter((m) => m.id <= from).slice(0, 2);
            return { _: 'messages', total_count: page.length, messages: page.map((m) => msg(m.id, m.text)) };
          }
        }
        throw { _: 'error', code: 400, message: `unexpected ${q._}` };
      },
    };
    return fake.client;
  },
}));

const { TdlEngine } = await import('../src/main/telegram/engine');

const settings = () => ({ tgApiId: '1', tgApiHash: 'x', llmBaseUrl: '', llmApiKey: '', llmModel: '', jevBaseUrl: '', jevApiKey: '', jevModel: '', handoffNotifyTo: '', ownerName: 'Кирилл', sttBaseUrl: '', sttApiKey: '', sttModel: '', ttsBaseUrl: '', ttsApiKey: '', ttsModel: '', ttsVoice: '', jevPricePerMTok: '0.042', sttPricePerMin: '0.006', ttsPricePerMin: '0.015', imagePricePerImage: '0.04', requestThreshold: '0.2', yookassaShopId: '', yookassaSecretKey: '', yookassaReturnUrl: '', auxBaseUrl: '', auxApiKey: '', auxModel: '', falKey: '', imageModel: '', newsInterests: '', operatorProvider: 'glm' as const, glmApiKey: '', deepseekApiKey: '', operatorBaseUrl: '', operatorApiKey: '', operatorModel: '', tavilyApiKey: '', geminiApiKey: '', aiProviders: '[]', aiMainModel: '', aiHelperModels: '[]', aiUseFree: '1' });
const dataDir = join(import.meta.dirname, '../tmp/tdlib-fake');
mkdirSync(dataDir, { recursive: true });

describe('TdlEngine with a fake TDLib client', () => {
  it('resolves a send whose confirmation arrived before the sendMessage response', async () => {
    const engine = new TdlEngine(dataDir, settings);
    const sent = await engine.sendDirect(1, 7, 'hi');
    expect(sent.messageId).toBe(500);
  }, 5000);

  it('pages history without duplicates, oldest first', async () => {
    fake.history = [5, 4, 3, 2, 1].map((id) => ({ id, text: `m${id}` }));
    const engine = new TdlEngine(dataDir, settings);
    const msgs = await engine.getHistory(1, -100, 0, null, 100);
    expect(msgs.map((m) => m.messageId)).toEqual([1, 2, 3, 4, 5]);
  });
});

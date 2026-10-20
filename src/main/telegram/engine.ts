// TDLib engine (tdl + prebuilt-tdlib). Stub: implemented by the telegram worker.

import type { Settings } from '../../shared/types';
import type { TelegramEngine, TgChat, TgLoginResult, TgMe, TgMessage } from './types';

const todo = (): never => {
  throw new Error('TdlEngine: not implemented');
};

export class TdlEngine implements TelegramEngine {
  constructor(readonly dataDir: string, readonly settings: () => Settings) {}
  async init(_accountIds: number[]): Promise<void> {}
  async close(): Promise<void> {}
  async startLogin(_a: number, _phone: string): Promise<TgLoginResult> { return todo(); }
  async submitCode(_a: number, _code: string): Promise<TgLoginResult> { return todo(); }
  async submitPassword(_a: number, _password: string): Promise<TgLoginResult> { return todo(); }
  async logout(_a: number): Promise<void> { return todo(); }
  async getMe(_a: number): Promise<TgMe> { return todo(); }
  async searchPublicChats(_a: number, _q: string): Promise<TgChat[]> { return todo(); }
  async searchPublicPosts(_a: number, _q: string, _limit: number): Promise<TgMessage[]> { return todo(); }
  async searchMessages(_a: number, _q: string, _since: number, _limit: number): Promise<TgMessage[]> { return todo(); }
  async resolveChat(_a: number, _link: string): Promise<TgChat> { return todo(); }
  async getChat(_a: number, _chatId: number): Promise<TgChat> { return todo(); }
  async getHistory(_a: number, _chatId: number, _since: number, _after: number | null, _limit: number): Promise<TgMessage[]> { return todo(); }
  async joinChat(_a: number, _chatId: number): Promise<void> { return todo(); }
  async sendDirect(_a: number, _userId: number, _text: string): Promise<TgMessage> { return todo(); }
  async replyInChat(_a: number, _chatId: number, _replyTo: number, _text: string): Promise<TgMessage> { return todo(); }
  onPrivateMessage(_cb: (accountId: number, msg: TgMessage) => void): void {}
}

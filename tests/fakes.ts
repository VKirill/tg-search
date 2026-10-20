import type { AccountStatus } from '../src/shared/types';
import type { Project } from '../src/shared/types';
import type { LeadAi, Qualification } from '../src/main/ai/types';
import type { TelegramEngine, TgChat, TgLoginResult, TgMe, TgMessage } from '../src/main/telegram/types';

export class FakeEngine implements TelegramEngine {
  chats = new Map<number, TgChat>();
  history = new Map<string, TgMessage[]>();
  searchChats: TgChat[] = [];
  searchPosts: TgMessage[] = [];
  searchMsgs: TgMessage[] = [];
  me: TgMe = {
    userId: 1,
    firstName: 'Test',
    lastName: 'User',
    username: 'tester',
    phone: '+1000',
    photoPath: null,
  };
  loginStatus: AccountStatus = 'authorized';
  privateMessageCb: ((accountId: number, msg: TgMessage) => void) | null = null;
  joinCalls: number[] = [];
  sent: { kind: 'dm' | 'chat'; accountId: number; text: string }[] = [];
  mustJoin = new Set<number>();
  qualifyHistoryFailOnce = new Set<number>();

  async init(_accountIds: number[]): Promise<void> {}
  async close(): Promise<void> {}

  async startLogin(_accountId: number, _phone: string): Promise<TgLoginResult> {
    return { status: this.loginStatus };
  }
  async submitCode(_accountId: number, _code: string): Promise<TgLoginResult> {
    return { status: this.loginStatus };
  }
  async submitPassword(_accountId: number, _password: string): Promise<TgLoginResult> {
    return { status: this.loginStatus };
  }
  async logout(_accountId: number): Promise<void> {}
  async getMe(_accountId: number): Promise<TgMe> {
    return this.me;
  }

  async searchPublicChats(_accountId: number, _query: string): Promise<TgChat[]> {
    return this.searchChats;
  }
  async searchPublicPosts(_accountId: number, _query: string, _limit: number): Promise<TgMessage[]> {
    return this.searchPosts;
  }
  async searchMessages(_accountId: number, _query: string, _since: number, _limit: number): Promise<TgMessage[]> {
    return this.searchMsgs;
  }
  resolveMap = new Map<string, TgChat>();
  failResolve = new Set<string>();

  async resolveChat(_accountId: number, linkOrUsername: string): Promise<TgChat> {
    if (this.failResolve.has(linkOrUsername)) throw new Error('not found');
    const mapped = this.resolveMap.get(linkOrUsername);
    if (mapped) return mapped;
    const chat = this.chats.values().next().value;
    if (!chat) throw new Error('no chat');
    return { ...chat, username: linkOrUsername.replace('@', '') };
  }
  async getChat(_accountId: number, chatId: number): Promise<TgChat> {
    const c = this.chats.get(chatId);
    if (!c) throw new Error(`chat ${chatId}`);
    return c;
  }

  setHistory(chatId: number, msgs: TgMessage[]) {
    this.history.set(String(chatId), msgs);
  }

  async getHistory(
    _accountId: number,
    chatId: number,
    _sinceMs: number,
    _afterMessageId: number | null,
    _limit: number,
  ): Promise<TgMessage[]> {
    if (this.mustJoin.has(chatId) && this.joinCalls.length === 0) {
      throw new Error('must join');
    }
    if (this.qualifyHistoryFailOnce.has(chatId) && this.joinCalls.length === 0) {
      this.qualifyHistoryFailOnce.delete(chatId);
      throw new Error('must join');
    }
    return this.history.get(String(chatId)) ?? [];
  }
  async joinChat(_accountId: number, chatId: number): Promise<void> {
    this.joinCalls.push(chatId);
    this.mustJoin.delete(chatId);
  }

  async sendDirect(accountId: number, userId: number, text: string): Promise<TgMessage> {
    this.sent.push({ kind: 'dm', accountId, text });
    return {
      chatId: userId,
      messageId: Date.now(),
      date: Date.now(),
      text,
      senderUserId: userId,
      senderChatId: null,
      senderName: null,
      senderUsername: null,
      senderIsBot: false,
      replyToMessageId: null,
      link: null,
      isOutgoing: true,
    };
  }
  async replyInChat(accountId: number, chatId: number, _replyTo: number, text: string): Promise<TgMessage> {
    if (this.mustJoin.has(chatId) && this.joinCalls.length === 0) throw new Error('must join');
    this.sent.push({ kind: 'chat', accountId, text });
    return {
      chatId,
      messageId: Date.now(),
      date: Date.now(),
      text,
      senderUserId: null,
      senderChatId: null,
      senderName: null,
      senderUsername: null,
      senderIsBot: false,
      replyToMessageId: null,
      link: null,
      isOutgoing: true,
    };
  }

  onPrivateMessage(cb: (accountId: number, msg: TgMessage) => void): void {
    this.privateMessageCb = cb;
  }

  emitPrivate(accountId: number, msg: TgMessage) {
    this.privateMessageCb?.(accountId, msg);
  }

  mustJoinPost = new Set<number>();
  posted: { accountId: number; chatId: number; text: string }[] = [];
  async sendToChat(accountId: number, chatId: number, text: string): Promise<TgMessage> {
    if (this.mustJoinPost.has(chatId) && !this.joinCalls.includes(chatId)) {
      throw new Error('USER_NOT_PARTICIPANT: not a member');
    }
    this.posted.push({ accountId, chatId, text });
    return {
      chatId, messageId: Date.now(), date: Date.now(), text, senderUserId: null, senderChatId: null,
      senderName: null, senderUsername: null, senderIsBot: false, replyToMessageId: null, link: null, isOutgoing: true,
    };
  }

  private chatMessageCb: ((accountId: number, msg: TgMessage) => void) | null = null;
  onChatMessage(cb: (accountId: number, msg: TgMessage) => void): void {
    this.chatMessageCb = cb;
  }
  emitChat(accountId: number, msg: TgMessage) {
    this.chatMessageCb?.(accountId, msg);
  }
}

export class FakeAi implements LeadAi {
  rateScore = 70;
  qualifyResults: Qualification[] = [];
  qualifyCalls = 0;
  draftText = 'Здравствуйте!';

  async suggestKeywords(): Promise<string[]> {
    return ['kw1', 'kw2'];
  }
  async rateChat(): Promise<{ score: number; reason: string }> {
    return { score: this.rateScore, reason: 'ok' };
  }
  async qualify(_project: Project, messages: TgMessage[]): Promise<Qualification[]> {
    this.qualifyCalls++;
    if (this.qualifyResults.length) return this.qualifyResults;
    return messages.map((m: TgMessage) => ({
      key: `${m.chatId}:${m.messageId}`,
      score: 80,
      label: 'demand' as const,
      reason: 'релевантно',
    }));
  }
  async draftReply(): Promise<string> {
    return this.draftText;
  }
}

export function makeChat(id: number, title = `Chat ${id}`): TgChat {
  return {
    chatId: id,
    title,
    username: `chat${id}`,
    kind: 'supergroup',
    memberCount: 100,
    description: 'desc',
    isMember: true,
  };
}

export function makeMsg(
  chatId: number,
  messageId: number,
  text: string,
  overrides: Partial<TgMessage> = {},
): TgMessage {
  return {
    chatId,
    messageId,
    date: Date.now(),
    text,
    senderUserId: 500 + messageId,
    senderChatId: null,
    senderIsBot: false,
    senderName: 'Author',
    senderUsername: 'author',
    replyToMessageId: null,
    link: `https://t.me/chat${chatId}/${messageId}`,
    isOutgoing: false,
    ...overrides,
  };
}

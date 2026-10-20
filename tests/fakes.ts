import type { AccountStatus, ClientCard, Lead, Project } from '../src/shared/types';
import type { DialogTurn, LeadAi, ManagerAi, Qualification } from '../src/main/ai/types';
import type { ManagerTestResult } from '../src/shared/types';
import type { SpeechService } from '../src/main/ai/speech';
import type { TelegramEngine, TgChat, TgLoginResult, TgMe, TgMessage } from '../src/main/telegram/types';

export class FakeEngine implements TelegramEngine {
  chats = new Map<number, TgChat>();
  history = new Map<string, TgMessage[]>();
  publicChats: TgChat[] = []; // results of searchPublicChats
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
    return this.publicChats;
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

  async ensurePrivateChat(_accountId: number, userId: number): Promise<number> {
    return userId;
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
      voice: null,
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
      voice: null,
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
      senderName: null, senderUsername: null, senderIsBot: false, voice: null, replyToMessageId: null, link: null, isOutgoing: true,
    };
  }

  voiceSent: { accountId: number; chatId: number; filePath: string; durationSec: number }[] = [];
  async sendVoice(accountId: number, chatId: number, filePath: string, durationSec: number): Promise<TgMessage> {
    this.voiceSent.push({ accountId, chatId, filePath, durationSec });
    return {
      chatId, messageId: Date.now(), date: Date.now(), text: '', senderUserId: null, senderChatId: null,
      senderName: null, senderUsername: null, senderIsBot: false, voice: { fileId: 1, durationSec }, replyToMessageId: null,
      link: null, isOutgoing: true,
    };
  }
  files = new Map<number, string>();
  async downloadFile(_accountId: number, fileId: number): Promise<string> {
    const path = this.files.get(fileId);
    if (!path) throw new Error(`file ${fileId}`);
    return path;
  }

  async listChats(_accountId: number, _limit: number) {
    return [...this.chats.values()].map((chat) => ({ chat, unreadCount: 0, last: null }));
  }
  async getMessagesBefore(_accountId: number, chatId: number, _before: number | null, limit: number): Promise<TgMessage[]> {
    return (this.history.get(String(chatId)) ?? []).slice(-limit);
  }
  async searchChats(_accountId: number, query: string): Promise<TgChat[]> {
    return [...this.chats.values()].filter((c) => c.title.toLowerCase().includes(query.toLowerCase()));
  }
  leftChats: number[] = [];
  async leaveChat(_accountId: number, chatId: number): Promise<void> {
    this.leftChats.push(chatId);
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

export class FakeManager implements ManagerAi {
  writeStepText = 'Шаг ИИ';
  replyResult: ManagerTestResult = { reply: 'Ответ менеджера', handoff: false, reason: '' };
  writeStepCalls = 0;
  replyCalls = 0;

  async writeStep(): Promise<string> {
    this.writeStepCalls++;
    return this.writeStepText;
  }
  lastCard: ClientCard | undefined;

  async reply(
    _project: Project,
    _lead: Lead,
    _history: DialogTurn[],
    _settings?: import('../src/shared/types').ManagerSettings,
    card?: ClientCard,
  ): Promise<ManagerTestResult> {
    this.replyCalls++;
    this.lastCard = card;
    return this.replyResult;
  }
}

export class FakeSpeech implements SpeechService {
  transcribeResult = 'тестовая расшифровка';
  synthesizeResult = { path: '/tmp/fake-voice.ogg', durationSec: 3 };
  transcribeCalls: string[] = [];
  synthesizeCalls: string[] = [];

  async transcribe(filePath: string): Promise<string> {
    this.transcribeCalls.push(filePath);
    return this.transcribeResult;
  }
  async synthesize(text: string): Promise<{ path: string; durationSec: number }> {
    this.synthesizeCalls.push(text);
    return this.synthesizeResult;
  }
  async prepareForStt(inputPath: string): Promise<{ path: string; cleanup: () => Promise<void> }> {
    return { path: inputPath, cleanup: async () => {} };
  }
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
    voice: null,
    senderName: 'Author',
    senderUsername: 'author',
    replyToMessageId: null,
    link: `https://t.me/chat${chatId}/${messageId}`,
    isOutgoing: false,
    ...overrides,
  };
}

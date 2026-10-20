// Contract of the Telegram engine (TDLib via tdl). Implemented in ./engine.ts.
// Chat and user IDs are TDLib IDs: they are the same for every account.

import type { AccountStatus, ChatKind } from '../../shared/types';

export interface TgChat {
  chatId: number;
  title: string;
  username: string | null;
  kind: ChatKind;
  memberCount: number | null;
  description: string | null;
  isMember: boolean;
}

export interface TgMessage {
  chatId: number;
  messageId: number;
  date: number; // unix ms
  text: string; // text or media caption; empty for media without caption
  senderUserId: number | null; // null when sent on behalf of a chat/channel
  senderChatId: number | null;
  senderName: string | null;
  senderUsername: string | null;
  senderIsBot: boolean; // chat moderation bots etc.: never leads
  voice: { fileId: number; durationSec: number } | null; // voice note (text is the caption, usually empty)
  replyToMessageId: number | null;
  link: string | null; // public t.me link when the chat has a username
  isOutgoing: boolean;
}

export interface TgMe {
  userId: number;
  firstName: string;
  lastName: string;
  username: string | null;
  phone: string;
  photoPath: string | null;
}

export interface TgLoginResult {
  status: AccountStatus;
  error?: string;
}

export interface TelegramEngine {
  // Opens the TDLib client of every stored account and resumes sessions.
  init(accountIds: number[]): Promise<void>;
  close(): Promise<void>;

  startLogin(accountId: number, phone: string): Promise<TgLoginResult>;
  submitCode(accountId: number, code: string): Promise<TgLoginResult>;
  submitPassword(accountId: number, password: string): Promise<TgLoginResult>;
  logout(accountId: number): Promise<void>;
  getMe(accountId: number): Promise<TgMe>;

  // Discovery
  searchPublicChats(accountId: number, query: string): Promise<TgChat[]>;
  searchPublicPosts(accountId: number, query: string, limit: number): Promise<TgMessage[]>; // [] when the free quota is spent
  searchMessages(accountId: number, query: string, sinceMs: number, limit: number): Promise<TgMessage[]>; // chats the account is in
  resolveChat(accountId: number, linkOrUsername: string): Promise<TgChat>;
  getChat(accountId: number, chatId: number): Promise<TgChat>;

  // Reading: messages newer than sinceMs and newer than afterMessageId, oldest first
  getHistory(accountId: number, chatId: number, sinceMs: number, afterMessageId: number | null, limit: number): Promise<TgMessage[]>;
  joinChat(accountId: number, chatId: number): Promise<void>;

  // Writing
  sendDirect(accountId: number, userId: number, text: string): Promise<TgMessage>;
  replyInChat(accountId: number, chatId: number, replyToMessageId: number, text: string): Promise<TgMessage>;

  sendToChat(accountId: number, chatId: number, text: string): Promise<TgMessage>; // plain post, e.g. broadcasts
  // Voice notes: OGG/Opus file; waveform is optional. Download returns a local file path.
  sendVoice(accountId: number, chatId: number, filePath: string, durationSec: number, replyToMessageId?: number): Promise<TgMessage>;
  downloadFile(accountId: number, fileId: number): Promise<string>;
  // Private chat with a user (created if needed); its id is where DMs to that user go.
  ensurePrivateChat(accountId: number, userId: number): Promise<number>;

  // New incoming messages in private chats (lead answers) for all accounts
  onPrivateMessage(cb: (accountId: number, msg: TgMessage) => void): void;
  // New messages in groups, supergroups and channels the accounts are members of (real-time monitoring).
  // The same message may arrive from several accounts; consumers dedupe by chatId:messageId.
  onChatMessage(cb: (accountId: number, msg: TgMessage) => void): void;
}

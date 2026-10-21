// TDLib engine (tdl + prebuilt-tdlib).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as tdl from 'tdl';
import { getTdjson } from 'prebuilt-tdlib';
import type { Client } from 'tdl';
import type {
  $FunctionInputByName,
  $FunctionName,
  $FunctionResultByName,
  AuthorizationState,
  ChatMemberStatus,
  InputMessageContent$Input,
  chat,
  error,
  message,
  supergroup,
  Update,
  user,
} from 'tdlib-types';
import type { AccountStatus, Settings } from '../../shared/types';
import {
  activeUsername,
  displayUserName,
  mapChat,
  mapMessage,
  mapUserToMe,
  senderIdsFromMessage,
} from './mappers';
import { hasRichMarkup, markdownToBlocks, markdownToFormatted } from './markdown';
import type { TelegramEngine, TgChat, TgLoginResult, TgMe, TgMessage } from './types';

const API_SETTINGS_ERROR = 'Укажите api_id и api_hash Telegram в настройках';
const SEND_TIMEOUT_MS = 30_000;

let tdlConfigured = false;

function ensureTdlConfigured(): void {
  if (tdlConfigured) return;
  tdl.configure({ tdjson: getTdjson(), verbosityLevel: 1 });
  tdlConfigured = true;
}

type PendingSend = {
  resolve: (msg: message) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type AuthWaiter = {
  check: () => void;
  want: AuthorizationState['_'][];
};

interface AccountSlot {
  accountId: number;
  client: Client;
  authStatus: AccountStatus;
  authWaiters: AuthWaiter[];
  pendingSends: Map<number, PendingSend>;
  // Send results that arrived before waitForSend registered (keyed by temporary message id).
  earlySends: Map<number, { message?: message; error?: error }>;
  noPostSearch?: boolean; // Telegram answered PREMIUM_ACCOUNT_REQUIRED: global post search is off for this account
  // Rich Messages from a user account need Telegram Premium (without it: RICH_MESSAGE_UNSUPPORTED); rechecked hourly
  rich?: { allowed: boolean; checkedAt: number };
}

function parseFloodWaitSeconds(message: string): number {
  const m = /FLOOD_WAIT_(\d+)/i.exec(message);
  if (m) return Number(m[1]);
  const m2 = /retry after (\d+)/i.exec(message);
  if (m2) return Number(m2[1]);
  return 60;
}

function authErrorToRussian(message: string): string {
  const table: Record<string, string> = {
    PHONE_CODE_INVALID: 'Неверный код подтверждения',
    PHONE_CODE_EXPIRED: 'Срок действия кода истёк, запросите новый',
    PHONE_NUMBER_INVALID: 'Некорректный номер телефона',
    PHONE_NUMBER_FLOOD: 'Слишком много попыток входа с этого номера',
    PASSWORD_HASH_INVALID: 'Неверный пароль двухфакторной аутентификации',
    PASSWORD_MISSING: 'Требуется пароль двухфакторной аутентификации',
  };
  return table[message] ?? `Ошибка Telegram: ${message}`;
}

function authStateToStatus(state: AuthorizationState): AccountStatus {
  switch (state._) {
    case 'authorizationStateReady':
      return 'authorized';
    case 'authorizationStateWaitCode':
      return 'wait_code';
    case 'authorizationStateWaitPassword':
      return 'wait_password';
    case 'authorizationStateClosed':
    case 'authorizationStateLoggingOut':
      return 'logged_out';
    default:
      return 'logged_out';
  }
}

function isTdError(v: unknown): v is error {
  return typeof v === 'object' && v !== null && (v as error)._ === 'error';
}

export class TdlEngine implements TelegramEngine {
  private readonly slots = new Map<number, AccountSlot>();
  private readonly supergroupCache = new Map<number, supergroup>();
  private readonly userCache = new Map<number, user>();
  private readonly chatUsernameCache = new Map<number, string | null>();
  private privateMessageCb: ((accountId: number, msg: TgMessage) => void) | null = null;
  private chatMessageCbs: ((accountId: number, msg: TgMessage) => void)[] = []; // lead search, the group helper…

  constructor(readonly dataDir: string, readonly settings: () => Settings) {}

  async init(accountIds: number[]): Promise<void> {
    ensureTdlConfigured();
    for (const accountId of accountIds) {
      await this.getOrCreateSlot(accountId);
    }
  }

  async close(): Promise<void> {
    const ids = [...this.slots.keys()];
    for (const id of ids) {
      const slot = this.slots.get(id);
      if (!slot) continue;
      try {
        await slot.client.close();
      } catch {
        // ignore close errors
      }
      this.slots.delete(id);
    }
  }

  onPrivateMessage(cb: (accountId: number, msg: TgMessage) => void): void {
    this.privateMessageCb = cb;
  }

  onChatMessage(cb: (accountId: number, msg: TgMessage) => void): void {
    this.chatMessageCbs.push(cb);
  }

  async startLogin(accountId: number, phone: string): Promise<TgLoginResult> {
    this.requireApiCredentials();
    const slot = await this.getOrCreateSlot(accountId);
    const state = (await this.invokeRaw(slot, { _: 'getAuthorizationState' })) as AuthorizationState;
    if (state._ === 'authorizationStateReady') {
      slot.authStatus = 'authorized';
      return { status: 'authorized' };
    }
    if (state._ !== 'authorizationStateWaitPhoneNumber') {
      return { status: slot.authStatus, error: 'Сейчас нельзя отправить номер телефона' };
    }
    const result = await this.invokeAuth(slot, { _: 'setAuthenticationPhoneNumber', phone_number: phone });
    if (isTdError(result)) {
      return { status: slot.authStatus, error: authErrorToRussian(result.message) };
    }
    const next = await this.waitForAuth(slot, ['authorizationStateWaitCode', 'authorizationStateReady'], 120_000);
    if (next._ === 'authorizationStateReady') return { status: 'authorized' };
    return { status: 'wait_code' };
  }

  async submitCode(accountId: number, code: string): Promise<TgLoginResult> {
    this.requireApiCredentials();
    const slot = await this.getOrCreateSlot(accountId);
    if (slot.authStatus !== 'wait_code') {
      return { status: slot.authStatus, error: 'Код сейчас не ожидается' };
    }
    const result = await this.invokeAuth(slot, { _: 'checkAuthenticationCode', code });
    if (isTdError(result)) {
      return { status: 'wait_code', error: authErrorToRussian(result.message) };
    }
    const next = await this.waitForAuth(
      slot,
      ['authorizationStateWaitPassword', 'authorizationStateReady'],
      120_000,
    );
    if (next._ === 'authorizationStateReady') return { status: 'authorized' };
    return { status: 'wait_password' };
  }

  async submitPassword(accountId: number, password: string): Promise<TgLoginResult> {
    this.requireApiCredentials();
    const slot = await this.getOrCreateSlot(accountId);
    if (slot.authStatus !== 'wait_password') {
      return { status: slot.authStatus, error: 'Пароль сейчас не ожидается' };
    }
    const result = await this.invokeAuth(slot, { _: 'checkAuthenticationPassword', password });
    if (isTdError(result)) {
      return { status: 'wait_password', error: authErrorToRussian(result.message) };
    }
    const next = await this.waitForAuth(slot, ['authorizationStateReady'], 120_000);
    if (next._ === 'authorizationStateReady') return { status: 'authorized' };
    return { status: slot.authStatus, error: 'Не удалось завершить вход' };
  }

  async logout(accountId: number): Promise<void> {
    const slot = this.slots.get(accountId);
    if (!slot) return;
    try {
      await this.invokeRaw(slot, { _: 'logOut' });
    } catch {
      // ignore
    }
    try {
      await slot.client.close();
    } catch {
      // ignore
    }
    this.slots.delete(accountId);
  }

  async getMe(accountId: number): Promise<TgMe> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const tdUser = await this.invoke(slot, { _: 'getMe' });
    let photoPath: string | null = null;
    const small = tdUser.profile_photo?.small;
    if (small?.id) {
      const file = await this.invoke(slot, {
        _: 'downloadFile',
        file_id: small.id,
        priority: 1,
        synchronous: true,
      });
      if (file.local?.is_downloading_completed && file.local.path) {
        photoPath = file.local.path;
      }
    }
    return mapUserToMe(tdUser, photoPath);
  }

  async searchPublicChats(accountId: number, query: string): Promise<TgChat[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const found = await this.invoke(slot, { _: 'searchPublicChats', query });
    const out: TgChat[] = [];
    for (const chatId of found.chat_ids) {
      const mapped = await this.loadTgChat(slot, chatId);
      if (mapped && mapped.kind !== 'private') out.push(mapped);
    }
    return out;
  }

  async searchPublicPosts(accountId: number, query: string, limit: number): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    if (slot.noPostSearch) return [];
    try {
      const limits = await this.invoke(slot, { _: 'getPublicPostSearchLimits', query });
      // is_current_query_free means "already paid for"; free daily queries come from remaining_free_query_count.
      if (!limits.is_current_query_free && limits.remaining_free_query_count <= 0) return [];
      const found = await this.invoke(slot, {
        _: 'searchPublicPosts',
        query,
        offset: '',
        limit,
        star_count: 0,
      });
      return await this.mapMessages(slot, found.messages);
    } catch (err) {
      if (err instanceof Error && err.message.includes('PREMIUM_ACCOUNT_REQUIRED')) {
        slot.noPostSearch = true;
        console.warn(`account ${accountId}: public post search needs Telegram Premium, skipping it`);
      } else {
        console.error('searchPublicPosts failed:', err);
      }
      return [];
    }
  }

  async searchMessages(
    accountId: number,
    query: string,
    sinceMs: number,
    limit: number,
  ): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const sinceSec = Math.floor(sinceMs / 1000);
    const found = await this.invoke(slot, {
      _: 'searchMessages',
      query,
      offset: '',
      limit,
      min_date: sinceSec,
      max_date: 0,
    });
    return await this.mapMessages(slot, found.messages);
  }

  async resolveChat(accountId: number, linkOrUsername: string): Promise<TgChat> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const trimmed = linkOrUsername.trim();
    const invite = parseInviteLink(trimmed);
    if (invite) {
      await this.invoke(slot, { _: 'checkChatInviteLink', invite_link: invite });
      const joined = await this.invoke(slot, { _: 'joinChatByInviteLink', invite_link: invite });
      if (joined._ !== 'chatJoinResultSuccess') {
        throw new Error('Не удалось вступить в чат по ссылке-приглашению');
      }
      const mapped = await this.loadTgChat(slot, joined.chat_id);
      if (!mapped) throw new Error('Не удалось открыть чат по ссылке-приглашению');
      return mapped;
    }
    const username = parsePublicUsername(trimmed);
    const chat = await this.invoke(slot, { _: 'searchPublicChat', username });
    const mapped = await this.loadTgChat(slot, chat.id);
    if (!mapped) throw new Error('Чат не найден');
    return mapped;
  }

  async resolveLink(accountId: number, url: string): Promise<{ chat: TgChat; messageId: number | null }> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const link = url.trim().replace(/^(https?:\/\/)?(www\.)?telegram\.me\//i, 'https://t.me/');
    const invite = parseInviteLink(link);
    if (invite) {
      const info = await this.invoke(slot, { _: 'checkChatInviteLink', invite_link: invite });
      if (!info.chat_id) throw new Error(`Это приглашение в чат «${info.title}» — вступите в него в «Чатах», чтобы открыть`);
      const chat = await this.loadTgChat(slot, info.chat_id);
      if (!chat) throw new Error('Чат не найден');
      return { chat, messageId: null };
    }
    if (/^(https?:\/\/)?t\.me\/(c\/\d+|[A-Za-z0-9_]+)\/\d+/i.test(link) || /^tg:\/\/(resolve|privatepost)/i.test(link)) {
      const info = await this.invoke(slot, { _: 'getMessageLinkInfo', url: link.startsWith('tg:') || /^https?:/i.test(link) ? link : `https://${link}` });
      const chat = await this.loadTgChat(slot, info.chat_id);
      if (!chat) throw new Error('Чат по ссылке не найден');
      return { chat, messageId: info.message?.id ?? null };
    }
    return { chat: await this.resolveChat(accountId, link), messageId: null };
  }

  async markRead(accountId: number, chatId: number, messageIds: number[]): Promise<void> {
    if (!messageIds.length) return;
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.invoke(slot, {
      _: 'viewMessages', chat_id: chatId, message_ids: messageIds, source: { _: 'messageSourceChatHistory' }, force_read: true,
    });
  }

  async react(accountId: number, chatId: number, messageId: number, emoji: string): Promise<void> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.invoke(slot, {
      _: 'addMessageReaction', chat_id: chatId, message_id: messageId,
      reaction_type: { _: 'reactionTypeEmoji', emoji }, is_big: false, update_recent_reactions: false,
    });
  }

  async getChat(accountId: number, chatId: number): Promise<TgChat> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const mapped = await this.loadTgChat(slot, chatId);
    if (!mapped) throw new Error('Чат не найден');
    return mapped;
  }

  async getHistory(
    accountId: number,
    chatId: number,
    sinceMs: number,
    afterMessageId: number | null,
    limit: number,
  ): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.ensureChatAccessible(slot, chatId);

    const collected: message[] = [];
    const seenIds = new Set<number>(); // offset 0 returns from_message_id again on the next page
    let fromMessageId = 0;
    let emptyPages = 0;

    while (collected.length < limit) {
      const page = await this.invoke(slot, {
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: Math.min(100, limit - collected.length),
        only_local: false,
      });
      const pageMessages = page.messages.filter((m): m is message => m !== null && !seenIds.has(m.id));
      // TDLib loads history from the server lazily: the first calls often return 0–1 messages.
      if (!pageMessages.length) {
        if (++emptyPages > 3) break;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      emptyPages = 0;
      for (const msg of pageMessages) {
        seenIds.add(msg.id);
        if (msg.date * 1000 < sinceMs) continue;
        if (afterMessageId !== null && msg.id <= afterMessageId) continue;
        collected.push(msg);
        if (collected.length >= limit) break;
      }

      const oldest = pageMessages[pageMessages.length - 1];
      if (!oldest) break;
      if (oldest.date * 1000 < sinceMs) break;
      if (afterMessageId !== null && oldest.id <= afterMessageId) break;

      const nextFrom = oldest.id;
      if (nextFrom === fromMessageId) break;
      fromMessageId = nextFrom;
    }

    collected.sort((a, b) => a.id - b.id);
    return await this.mapMessages(slot, collected);
  }

  async listChats(
    accountId: number,
    limit: number,
  ): Promise<{ chat: TgChat; unreadCount: number; last: TgMessage | null }[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    try {
      await this.invoke(slot, { _: 'loadChats', chat_list: { _: 'chatListMain' }, limit });
    } catch {
      // 404 means every chat of the list is already loaded
    }
    const { chat_ids } = await this.invoke(slot, { _: 'getChats', chat_list: { _: 'chatListMain' }, limit });
    const out: { chat: TgChat; unreadCount: number; last: TgMessage | null }[] = [];
    for (const id of chat_ids) {
      const td = await this.invoke(slot, { _: 'getChat', chat_id: id });
      const chat = await this.lightChat(slot, td);
      const last = td.last_message ? mapMessage(td.last_message, { chatUsername: chat.username }) : null;
      out.push({ chat, unreadCount: td.unread_count, last });
    }
    return out;
  }

  async getMessagesBefore(
    accountId: number,
    chatId: number,
    beforeMessageId: number | null,
    limit: number,
  ): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.ensureChatAccessible(slot, chatId);
    const collected: message[] = [];
    const seenIds = new Set<number>(beforeMessageId ? [beforeMessageId] : []);
    let fromMessageId = beforeMessageId ?? 0;
    let emptyPages = 0;
    while (collected.length < limit) {
      const page = await this.invoke(slot, {
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: Math.min(100, limit - collected.length + 1),
        only_local: false,
      });
      const fresh = page.messages.filter((m): m is message => m !== null && !seenIds.has(m.id));
      // TDLib loads history lazily; the start of the chat also ends here after a few empty pages
      if (!fresh.length) {
        if (++emptyPages > 3) break;
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      emptyPages = 0;
      for (const m of fresh) {
        seenIds.add(m.id);
        collected.push(m);
      }
      fromMessageId = fresh[fresh.length - 1].id;
    }
    collected.sort((a, b) => a.id - b.id);
    return await this.mapMessages(slot, collected.slice(-limit));
  }

  async searchChats(accountId: number, query: string): Promise<TgChat[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const ids = async (q: Promise<{ chat_ids: number[] }>) => (await q.catch(() => ({ chat_ids: [] }))).chat_ids;
    const own = await ids(this.invoke(slot, { _: 'searchChats', query, limit: 20 }));
    const pub = await ids(this.invoke(slot, { _: 'searchPublicChats', query }));
    const out: TgChat[] = [];
    for (const id of [...new Set([...own, ...pub])].slice(0, 40)) {
      out.push(await this.lightChat(slot, await this.invoke(slot, { _: 'getChat', chat_id: id })));
    }
    return out;
  }

  async getMessagesAround(accountId: number, chatId: number, messageId: number, limit: number): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.ensureChatAccessible(slot, chatId);
    // negative offset returns newer messages too: from_message_id sits in the middle of the page
    const half = Math.floor(limit / 2);
    const page = await this.invoke(slot, {
      _: 'getChatHistory', chat_id: chatId, from_message_id: messageId, offset: -half, limit, only_local: false,
    });
    const msgs = page.messages.filter((m): m is message => m !== null).sort((a, b) => a.id - b.id);
    return await this.mapMessages(slot, msgs);
  }

  async leaveChat(accountId: number, chatId: number): Promise<void> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.invoke(slot, { _: 'leaveChat', chat_id: chatId });
  }

  async joinChat(accountId: number, chatId: number): Promise<void> {
    const slot = await this.requireAuthorizedSlot(accountId);
    await this.invoke(slot, { _: 'joinChat', chat_id: chatId });
  }

  async sendDirect(accountId: number, userId: number, text: string): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const chatId = await this.ensurePrivateChatSlot(slot, userId);
    return await this.sendText(slot, chatId, text);
  }

  /** TDLib private chat id for a user (used for voice notes in DM). */
  async ensurePrivateChat(accountId: number, userId: number): Promise<number> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return this.ensurePrivateChatSlot(slot, userId);
  }

  private async ensurePrivateChatSlot(slot: AccountSlot, userId: number): Promise<number> {
    const chat = await this.invoke(slot, { _: 'createPrivateChat', user_id: userId, force: false });
    return chat.id;
  }

  async replyInChat(
    accountId: number,
    chatId: number,
    replyToMessageId: number,
    text: string,
  ): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return await this.sendText(slot, chatId, text, replyToMessageId);
  }

  async sendToChat(accountId: number, chatId: number, text: string): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return await this.sendText(slot, chatId, text);
  }

  async sendVoice(
    accountId: number,
    chatId: number,
    filePath: string,
    durationSec: number,
    replyToMessageId?: number,
  ): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return await this.sendContent(
      slot,
      chatId,
      {
        _: 'inputMessageVoiceNote',
        voice_note: {
          _: 'inputVoiceNote',
          voice_note: { _: 'inputFileLocal', path: filePath },
          duration: Math.max(1, Math.round(durationSec)),
        },
      },
      replyToMessageId,
    );
  }

  async sendPhoto(accountId: number, chatId: number, filePath: string, caption?: string): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return await this.sendContent(slot, chatId, {
      _: 'inputMessagePhoto',
      photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: filePath } },
      ...(caption ? { caption: markdownToFormatted(caption) } : {}),
    });
  }

  async sendDocument(accountId: number, chatId: number, filePath: string, caption?: string): Promise<TgMessage> {
    const slot = await this.requireAuthorizedSlot(accountId);
    return await this.sendContent(slot, chatId, {
      _: 'inputMessageDocument',
      document: { _: 'inputDocument', document: { _: 'inputFileLocal', path: filePath } },
      ...(caption ? { caption: markdownToFormatted(caption) } : {}),
    });
  }

  async getUserPhoto(accountId: number, userId: number): Promise<string | null> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const u = await this.invoke(slot, { _: 'getUser', user_id: userId });
    const big = u.profile_photo?.big;
    if (!big?.id) return null;
    return await this.downloadFile(accountId, big.id);
  }

  async downloadFile(accountId: number, fileId: number): Promise<string> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const file = await this.invoke(slot, { _: 'downloadFile', file_id: fileId, priority: 1, offset: 0, limit: 0, synchronous: true });
    if (!file.local.is_downloading_completed) throw new Error('Не удалось скачать файл из Telegram');
    return file.local.path;
  }

  // ——— internals ———

  private requireApiCredentials(): void {
    const { tgApiId, tgApiHash } = this.settings();
    if (!tgApiId.trim() || !tgApiHash.trim()) {
      throw new Error(API_SETTINGS_ERROR);
    }
  }

  private apiCredentials(): { apiId: number; apiHash: string } {
    this.requireApiCredentials();
    const { tgApiId, tgApiHash } = this.settings();
    return { apiId: Number(tgApiId), apiHash: tgApiHash };
  }

  private accountDirs(accountId: number): { db: string; files: string } {
    const base = join(this.dataDir, `acc-${accountId}`);
    const db = join(base, 'db');
    const files = join(base, 'files');
    mkdirSync(db, { recursive: true });
    mkdirSync(files, { recursive: true });
    return { db, files };
  }

  private async getOrCreateSlot(accountId: number): Promise<AccountSlot> {
    const existing = this.slots.get(accountId);
    if (existing) return existing;

    ensureTdlConfigured();
    const { apiId, apiHash } = this.apiCredentials();
    const { db, files } = this.accountDirs(accountId);
    const client = tdl.createClient({
      apiId,
      apiHash,
      databaseDirectory: db,
      filesDirectory: files,
    });

    const slot: AccountSlot = {
      accountId,
      client,
      authStatus: 'logged_out',
      authWaiters: [],
      pendingSends: new Map(),
      earlySends: new Map(),
    };

    client.on('error', (err) => console.error(`TDLib account ${accountId}:`, err));

    client.on('update', (update: Update) => {
      void this.onUpdate(slot, update);
    });

    this.slots.set(accountId, slot);

    const state = (await this.invokeRaw(slot, { _: 'getAuthorizationState' })) as AuthorizationState;
    slot.authStatus = authStateToStatus(state);
    return slot;
  }

  private async requireAuthorizedSlot(accountId: number): Promise<AccountSlot> {
    this.requireApiCredentials();
    const slot = await this.getOrCreateSlot(accountId);
    if (slot.authStatus !== 'authorized') {
      const state = (await this.invokeRaw(slot, { _: 'getAuthorizationState' })) as AuthorizationState;
      slot.authStatus = authStateToStatus(state);
    }
    if (slot.authStatus !== 'authorized') {
      throw new Error('Аккаунт не авторизован в Telegram');
    }
    return slot;
  }

  private async onUpdate(slot: AccountSlot, update: Update): Promise<void> {
    if (update._ === 'updateAuthorizationState') {
      const state = update.authorization_state;
      slot.authStatus = authStateToStatus(state);
      for (const w of slot.authWaiters) {
        if (w.want.includes(state._)) w.check();
      }
      return;
    }

    if (update._ === 'updateMessageSendSucceeded') {
      const pending = slot.pendingSends.get(update.old_message_id);
      if (pending) {
        clearTimeout(pending.timer);
        slot.pendingSends.delete(update.old_message_id);
        pending.resolve(update.message);
      } else {
        slot.earlySends.set(update.old_message_id, { message: update.message });
      }
      return;
    }

    if (update._ === 'updateMessageSendFailed') {
      const pending = slot.pendingSends.get(update.old_message_id);
      if (pending) {
        clearTimeout(pending.timer);
        slot.pendingSends.delete(update.old_message_id);
        pending.reject(this.tdErrorToJsError(update.error));
      } else {
        slot.earlySends.set(update.old_message_id, { error: update.error });
      }
      return;
    }

    if (update._ === 'updateNewMessage' && (this.privateMessageCb || this.chatMessageCbs.length)) {
      const msg = update.message;
      if (msg.is_outgoing) return;
      try {
        const tdChat = await this.invoke(slot, { _: 'getChat', chat_id: msg.chat_id });
        const cbs = tdChat.type._ === 'chatTypePrivate' ? [this.privateMessageCb].filter((c) => !!c) : this.chatMessageCbs;
        if (!cbs.length) return;
        const mapped = await this.mapOneMessage(slot, msg, tdChat);
        for (const cb of cbs) cb!(slot.accountId, mapped);
      } catch (err) {
        console.error('new message handler failed:', err);
      }
    }
  }

  private waitForAuth(
    slot: AccountSlot,
    want: AuthorizationState['_'][],
    timeoutMs: number,
  ): Promise<AuthorizationState> {
    return new Promise((resolve, reject) => {
      let waiter: AuthWaiter;

      const timer = setTimeout(() => {
        slot.authWaiters = slot.authWaiters.filter((w) => w !== waiter);
        reject(new Error('Таймаут ожидания ответа Telegram'));
      }, timeoutMs);

      const finish = (state: AuthorizationState) => {
        clearTimeout(timer);
        slot.authWaiters = slot.authWaiters.filter((w) => w !== waiter);
        resolve(state);
      };

      const tryResolve = () => {
        void this.invokeRaw(slot, { _: 'getAuthorizationState' })
          .then((state) => {
            const s = state as AuthorizationState;
            if (want.includes(s._)) finish(s);
          })
          .catch(reject);
      };

      waiter = { want, check: tryResolve };
      slot.authWaiters.push(waiter);
      tryResolve();
    });
  }

  private async invokeAuth<F extends $FunctionName>(
    slot: AccountSlot,
    query: { _: F } & $FunctionInputByName[F],
  ): Promise<$FunctionResultByName[F] | error> {
    try {
      return (await slot.client.invoke(query as never)) as $FunctionResultByName[F];
    } catch (err) {
      if (isTdError(err)) return err;
      throw err;
    }
  }

  private async invokeRaw<F extends $FunctionName>(
    slot: AccountSlot,
    query: { _: F } & $FunctionInputByName[F],
  ): Promise<$FunctionResultByName[F]> {
    return (await slot.client.invoke(query as never)) as $FunctionResultByName[F];
  }

  private async invoke<F extends $FunctionName>(
    slot: AccountSlot,
    query: { _: F } & $FunctionInputByName[F],
  ): Promise<$FunctionResultByName[F]> {
    try {
      return (await slot.client.invoke(query as never)) as $FunctionResultByName[F];
    } catch (err) {
      throw this.wrapInvokeError(err);
    }
  }

  private wrapInvokeError(err: unknown): Error {
    if (isTdError(err)) return this.tdErrorToJsError(err);
    if (err instanceof Error) return err;
    return new Error(String(err));
  }

  private tdErrorToJsError(td: error): Error {
    if (td.code === 429 || td.message.includes('FLOOD_WAIT')) {
      const retryAfter = parseFloodWaitSeconds(td.message);
      const e = new Error(`Слишком много запросов. Повторите через ${retryAfter} с.`);
      (e as Error & { retryAfter?: number }).retryAfter = retryAfter;
      return e;
    }
    return new Error(authErrorToRussian(td.message));
  }

  private async getSupergroupCached(slot: AccountSlot, supergroupId: number): Promise<supergroup> {
    const cached = this.supergroupCache.get(supergroupId);
    if (cached) return cached;
    const sg = await this.invoke(slot, { _: 'getSupergroup', supergroup_id: supergroupId });
    this.supergroupCache.set(supergroupId, sg);
    return sg;
  }

  private async getUserCached(slot: AccountSlot, userId: number): Promise<user> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    const u = await this.invoke(slot, { _: 'getUser', user_id: userId });
    this.userCache.set(userId, u);
    return u;
  }

  private async chatUsername(slot: AccountSlot, tdChat: chat): Promise<string | null> {
    const cached = this.chatUsernameCache.get(tdChat.id);
    if (cached !== undefined) return cached;

    let username: string | null = null;
    if (tdChat.type._ === 'chatTypeSupergroup') {
      const sg = await this.getSupergroupCached(slot, tdChat.type.supergroup_id);
      username = activeUsername(sg.usernames);
    } else if (tdChat.type._ === 'chatTypePrivate') {
      const u = await this.getUserCached(slot, tdChat.type.user_id);
      username = activeUsername(u.usernames);
    }
    this.chatUsernameCache.set(tdChat.id, username);
    return username;
  }

  // Chat without full info requests: enough for lists (no description).
  private async lightChat(slot: AccountSlot, tdChat: chat): Promise<TgChat> {
    if (tdChat.type._ === 'chatTypePrivate') {
      const u = await this.getUserCached(slot, tdChat.type.user_id);
      return mapChat(tdChat, { username: activeUsername(u.usernames) });
    }
    if (tdChat.type._ === 'chatTypeBasicGroup') {
      const bg = await this.invoke(slot, { _: 'getBasicGroup', basic_group_id: tdChat.type.basic_group_id });
      return mapChat(tdChat, { basicGroup: bg });
    }
    if (tdChat.type._ === 'chatTypeSupergroup') {
      return mapChat(tdChat, { supergroup: await this.getSupergroupCached(slot, tdChat.type.supergroup_id) });
    }
    return mapChat(tdChat);
  }

  private async loadTgChat(slot: AccountSlot, chatId: number): Promise<TgChat | null> {
    const tdChat = await this.invoke(slot, { _: 'getChat', chat_id: chatId });
    if (tdChat.type._ === 'chatTypePrivate') {
      const u = await this.getUserCached(slot, tdChat.type.user_id);
      return mapChat(tdChat, { username: activeUsername(u.usernames) });
    }
    if (tdChat.type._ === 'chatTypeBasicGroup') {
      const bg = await this.invoke(slot, { _: 'getBasicGroup', basic_group_id: tdChat.type.basic_group_id });
      let description: string | null = null;
      try {
        const full = await this.invoke(slot, {
          _: 'getBasicGroupFullInfo',
          basic_group_id: tdChat.type.basic_group_id,
        });
        description = full.description || null;
      } catch {
        description = null;
      }
      return mapChat(tdChat, { basicGroup: bg, description });
    }
    if (tdChat.type._ === 'chatTypeSupergroup') {
      const sg = await this.getSupergroupCached(slot, tdChat.type.supergroup_id);
      let description: string | null = null;
      let linkedChatId: number | null = null;
      try {
        const full = await this.invoke(slot, {
          _: 'getSupergroupFullInfo',
          supergroup_id: tdChat.type.supergroup_id,
        });
        description = full.description || null;
        linkedChatId = full.linked_chat_id || null;
      } catch {
        description = null;
      }
      return { ...mapChat(tdChat, { supergroup: sg, description }), linkedChatId };
    }
    return mapChat(tdChat);
  }

  private async ensureChatAccessible(slot: AccountSlot, chatId: number): Promise<void> {
    const tdChat = await this.invoke(slot, { _: 'getChat', chat_id: chatId });
    if (tdChat.type._ === 'chatTypeSupergroup') {
      const sg = await this.getSupergroupCached(slot, tdChat.type.supergroup_id);
      if (!isMemberStatus(sg.status)) {
        const username = activeUsername(sg.usernames);
        if (username) {
          await this.invoke(slot, { _: 'searchPublicChat', username });
        }
        await this.invoke(slot, { _: 'openChat', chat_id: chatId });
      }
    }
  }

  private async mapOneMessage(slot: AccountSlot, msg: message, tdChat?: chat): Promise<TgMessage> {
    const chat = tdChat ?? await this.invoke(slot, { _: 'getChat', chat_id: msg.chat_id });
    const chatUsername = await this.chatUsername(slot, chat);
    const { senderUserId, senderChatId } = senderIdsFromMessage(msg);
    let senderName: string | null = null;
    let senderUsername: string | null = null;
    let senderIsBot = false;
    if (senderUserId) {
      const u = await this.getUserCached(slot, senderUserId);
      senderName = displayUserName(u);
      senderUsername = activeUsername(u.usernames);
      senderIsBot = u.type._ === 'userTypeBot';
    } else if (senderChatId) {
      const senderChat = await this.invoke(slot, { _: 'getChat', chat_id: senderChatId });
      senderName = senderChat.title;
      senderUsername = await this.chatUsername(slot, senderChat);
    }
    return mapMessage(msg, { chatUsername, senderName, senderUsername, senderIsBot });
  }

  private async mapMessages(slot: AccountSlot, messages: message[]): Promise<TgMessage[]> {
    const out: TgMessage[] = [];
    for (const msg of messages) {
      out.push(await this.mapOneMessage(slot, msg));
    }
    return out;
  }

  private waitForSend(slot: AccountSlot, oldMessageId: number): Promise<message> {
    const early = slot.earlySends.get(oldMessageId);
    if (early) {
      slot.earlySends.delete(oldMessageId);
      return early.message ? Promise.resolve(early.message) : Promise.reject(this.tdErrorToJsError(early.error!));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pendingSends.delete(oldMessageId);
        reject(new Error('Таймаут отправки сообщения'));
      }, SEND_TIMEOUT_MS);
      slot.pendingSends.set(oldMessageId, {
        resolve,
        reject,
        timer,
      });
    });
  }

  private async canSendRich(slot: AccountSlot): Promise<boolean> {
    if (!slot.rich || Date.now() - slot.rich.checkedAt > 3600_000) {
      const me = await this.invoke(slot, { _: 'getMe' }).catch(() => null);
      slot.rich = { allowed: !!me?.is_premium, checkedAt: Date.now() };
    }
    return slot.rich.allowed;
  }

  private async sendText(
    slot: AccountSlot,
    chatId: number,
    text: string,
    replyToMessageId?: number,
  ): Promise<TgMessage> {
    // Structured replies (lists, headings, tables, bold…) go as a Telegram Rich Message; plain text stays a plain message
    if (hasRichMarkup(text) && (await this.canSendRich(slot))) {
      try {
        return await this.sendContent(
          slot,
          chatId,
          {
            _: 'inputMessageRichMessage',
            message: {
              _: 'inputRichMessage',
              source: { _: 'richMessageSourceBlocks', blocks: markdownToBlocks(text) as never },
              is_rtl: false,
              detect_automatic_blocks: true,
            },
            clear_draft: false,
          },
          replyToMessageId,
        );
      } catch (err) {
        console.error('rich message refused, sending formatted text', err);
        if (/RICH_MESSAGE_UNSUPPORTED|PREMIUM/i.test(String(err))) slot.rich = { allowed: false, checkedAt: Date.now() };
      }
    }
    return this.sendContent(
      slot,
      chatId,
      { _: 'inputMessageText', text: markdownToFormatted(text) },
      replyToMessageId,
    );
  }

  async sendAlbum(
    accountId: number,
    chatId: number,
    files: { path: string; kind: 'photo' | 'document' }[],
    caption?: string,
  ): Promise<TgMessage[]> {
    const slot = await this.requireAuthorizedSlot(accountId);
    const cap = caption?.trim() ? markdownToFormatted(caption.trim()) : undefined;
    const contents: InputMessageContent$Input[] = files.map((f, i) =>
      f.kind === 'photo'
        ? { _: 'inputMessagePhoto', photo: { _: 'inputPhoto', photo: { _: 'inputFileLocal', path: f.path } }, ...(i === 0 && cap ? { caption: cap } : {}) }
        : { _: 'inputMessageDocument', document: { _: 'inputDocument', document: { _: 'inputFileLocal', path: f.path } }, ...(i === 0 && cap ? { caption: cap } : {}) },
    ) as unknown as InputMessageContent$Input[];
    const sent = await this.invoke(slot, { _: 'sendMessageAlbum', chat_id: chatId, input_message_contents: contents });
    const finals = await Promise.all(sent.messages.filter((m): m is message => m != null).map((m) => this.waitForSend(slot, m.id)));
    const tdChat = await this.invoke(slot, { _: 'getChat', chat_id: chatId });
    return Promise.all(finals.map((m) => this.mapOneMessage(slot, m, tdChat)));
  }

  private async sendContent(
    slot: AccountSlot,
    chatId: number,
    content: InputMessageContent$Input,
    replyToMessageId?: number,
  ): Promise<TgMessage> {
    const input = {
      _: 'sendMessage' as const,
      chat_id: chatId,
      input_message_content: content,
      ...(replyToMessageId
        ? { reply_to: { _: 'inputMessageReplyToMessage' as const, message_id: replyToMessageId } }
        : {}),
    };
    const sent = await this.invoke(slot, input);
    const finalMsg = await this.waitForSend(slot, sent.id);
    const tdChat = await this.invoke(slot, { _: 'getChat', chat_id: chatId });
    return await this.mapOneMessage(slot, finalMsg, tdChat);
  }
}

function isMemberStatus(status: ChatMemberStatus): boolean {
  return status._ !== 'chatMemberStatusLeft' && status._ !== 'chatMemberStatusBanned';
}

function parsePublicUsername(input: string): string {
  let s = input.trim();
  s = s.replace(/^https?:\/\//i, '');
  s = s.replace(/^t\.me\//i, '');
  s = s.replace(/^@/, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  return s;
}

function parseInviteLink(input: string): string | null {
  const normalized = input.replace(/^https?:\/\//i, '');
  const m = /^(?:t\.me\/)(\+[A-Za-z0-9_-]+)/i.exec(normalized);
  if (!m) return null;
  return `https://t.me/${m[1]}`;
}

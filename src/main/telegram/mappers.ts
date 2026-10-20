// Pure TDLib → domain mappers (no I/O).

import type { ChatKind } from '../../shared/types';
import type {
  ChatMemberStatus,
  MessageContent,
  basicGroup,
  chat,
  message,
  supergroup,
  usernames,
  user,
} from 'tdlib-types';
import type { TgChat, TgMe, TgMessage } from './types';

const MESSAGE_LINK_SHIFT = 2 ** 20;

export function activeUsername(usernames: usernames | undefined): string | null {
  const list = usernames?.active_usernames;
  if (!list?.length) return null;
  return list[0] ?? null;
}

export function isChatMemberStatus(status: ChatMemberStatus): boolean {
  return status._ !== 'chatMemberStatusLeft' && status._ !== 'chatMemberStatusBanned';
}

export function chatKindFromTd(
  chatType: chat['type'],
  supergroup?: supergroup,
): ChatKind {
  switch (chatType._) {
    case 'chatTypePrivate':
      return 'private';
    case 'chatTypeBasicGroup':
      return 'group';
    case 'chatTypeSupergroup':
      if (supergroup?.is_channel ?? chatType.is_channel) return 'channel';
      return 'supergroup';
    default:
      return 'private';
  }
}

export function mapChat(
  tdChat: chat,
  opts: {
    supergroup?: supergroup;
    basicGroup?: basicGroup;
    description?: string | null;
    username?: string | null;
  } = {},
): TgChat {
  const { supergroup, basicGroup, description = null, username: usernameOverride } = opts;
  const kind = chatKindFromTd(tdChat.type, supergroup);

  let memberCount: number | null = null;
  let isMember = false;
  let username = usernameOverride ?? null;

  if (supergroup) {
    memberCount = supergroup.member_count > 0 ? supergroup.member_count : null;
    isMember = isChatMemberStatus(supergroup.status);
    username = username ?? activeUsername(supergroup.usernames);
  } else if (basicGroup) {
    memberCount = basicGroup.member_count > 0 ? basicGroup.member_count : null;
    isMember = isChatMemberStatus(basicGroup.status);
  } else if (tdChat.type._ === 'chatTypePrivate') {
    isMember = true;
  }

  return {
    chatId: tdChat.id,
    title: tdChat.title,
    username,
    kind,
    memberCount,
    description,
    isMember,
  };
}

export function buildPublicMessageLink(username: string | null, messageId: number): string | null {
  if (!username) return null;
  const publicId = Math.floor(messageId / MESSAGE_LINK_SHIFT);
  if (publicId <= 0) return null;
  return `https://t.me/${username}/${publicId}`;
}

export function extractMessageText(content: MessageContent): string {
  if (content._ === 'messageText') return content.text.text;
  if ('caption' in content && content.caption && typeof content.caption === 'object' && 'text' in content.caption) {
    return content.caption.text;
  }
  return '';
}

export function senderIdsFromMessage(msg: message): { senderUserId: number | null; senderChatId: number | null } {
  const sid = msg.sender_id;
  if (sid._ === 'messageSenderUser') return { senderUserId: sid.user_id, senderChatId: null };
  if (sid._ === 'messageSenderChat') return { senderUserId: null, senderChatId: sid.chat_id };
  return { senderUserId: null, senderChatId: null };
}

export function replyToMessageId(msg: message): number | null {
  const reply = msg.reply_to;
  if (reply?._ === 'messageReplyToMessage' && reply.message_id) return reply.message_id;
  return null;
}

function voiceOf(msg: message): TgMessage['voice'] {
  if (msg.content._ !== 'messageVoiceNote') return null;
  const note = msg.content.voice_note;
  return { fileId: note.voice.id, durationSec: note.duration };
}

export function mapMessage(
  msg: message,
  opts: {
    chatUsername?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderIsBot?: boolean;
  } = {},
): TgMessage {
  const { senderUserId, senderChatId } = senderIdsFromMessage(msg);
  const chatUsername = opts.chatUsername ?? null;

  return {
    chatId: msg.chat_id,
    messageId: msg.id,
    date: msg.date * 1000,
    text: extractMessageText(msg.content),
    senderUserId,
    senderChatId,
    senderName: opts.senderName ?? null,
    senderUsername: opts.senderUsername ?? null,
    senderIsBot: opts.senderIsBot ?? false,
    voice: voiceOf(msg),
    replyToMessageId: replyToMessageId(msg),
    link: buildPublicMessageLink(chatUsername, msg.id),
    isOutgoing: msg.is_outgoing,
  };
}

export function mapUserToMe(tdUser: user, photoPath: string | null): TgMe {
  return {
    userId: tdUser.id,
    firstName: tdUser.first_name,
    lastName: tdUser.last_name,
    username: activeUsername(tdUser.usernames),
    phone: tdUser.phone_number,
    photoPath,
  };
}

export function displayUserName(tdUser: user): string {
  const parts = [tdUser.first_name, tdUser.last_name].filter(Boolean);
  return parts.join(' ').trim() || tdUser.first_name;
}

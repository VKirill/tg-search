import { describe, expect, it } from 'vitest';
import type { chat, message, supergroup } from 'tdlib-types';
import {
  buildPublicMessageLink,
  chatKindFromTd,
  extractMessageText,
  mapChat,
  mapMessage,
  senderIdsFromMessage,
} from '../src/main/telegram/mappers';

const supergroupChannel = (): supergroup =>
  ({
    _: 'supergroup',
    id: 1,
    date: 0,
    status: { _: 'chatMemberStatusMember', member_until_date: 0 },
    member_count: 1200,
    boost_level: 0,
    has_automatic_translation: false,
    has_linked_chat: false,
    has_location: false,
    sign_messages: false,
    show_message_sender: false,
    join_to_send_messages: false,
    join_by_request: false,
    is_slow_mode_enabled: false,
    is_channel: true,
    is_broadcast_group: false,
    is_forum: false,
    is_direct_messages_group: false,
    is_direct_messages_channel: false,
    has_sensitive_content: false,
    restriction_reason: '',
    paid_message_star_count: 0,
    has_active_story: false,
    has_stories: false,
    usernames: {
      _: 'usernames',
      active_usernames: ['newschannel'],
      disabled_usernames: [],
      editable_username: 'newschannel',
      collectible_usernames: [],
    },
  }) as unknown as supergroup;

const tdChat = (): chat =>
  ({
    _: 'chat',
    id: -100123,
    type: { _: 'chatTypeSupergroup', supergroup_id: 1, is_channel: true },
    title: 'News',
  }) as chat;

const textMessage = (overrides: Partial<message> = {}): message =>
  ({
    _: 'message',
    id: 5 * 2 ** 20 + 42,
    sender_id: { _: 'messageSenderUser', user_id: 99 },
    chat_id: -100123,
    is_outgoing: false,
    is_pinned: false,
    is_from_offline: false,
    can_be_saved: true,
    has_timestamped_media: false,
    is_channel_post: true,
    is_paid_star_suggested_post: false,
    is_paid_gram_suggested_post: false,
    contains_unread_mention: false,
    contains_unread_poll_votes: false,
    date: 1_700_000_000,
    edit_date: 0,
    unread_reactions: [],
    self_destruct_in: 0,
    auto_delete_in: 0,
    via_bot_user_id: 0,
    sender_boost_count: 0,
    sender_tag: '',
    paid_message_star_count: 0,
    author_signature: '',
    media_album_id: '0',
    effect_id: '0',
    summary_language_code: '',
    content: { _: 'messageText', text: { _: 'formattedText', text: 'Hello world', entities: [] } },
    ephemeral_message_id: 0,
    chat_instance: '0',
    ...overrides,
  }) as unknown as message;

describe('chatKindFromTd', () => {
  it('maps supergroup channel vs group', () => {
    expect(
      chatKindFromTd({ _: 'chatTypeSupergroup', supergroup_id: 1, is_channel: true }, supergroupChannel()),
    ).toBe('channel');
    expect(
      chatKindFromTd(
        { _: 'chatTypeSupergroup', supergroup_id: 1, is_channel: false },
        { ...supergroupChannel(), is_channel: false },
      ),
    ).toBe('supergroup');
  });
});

describe('mapChat', () => {
  it('reads username and member count from supergroup', () => {
    const mapped = mapChat(tdChat(), { supergroup: supergroupChannel(), description: 'About' });
    expect(mapped.username).toBe('newschannel');
    expect(mapped.memberCount).toBe(1200);
    expect(mapped.kind).toBe('channel');
    expect(mapped.isMember).toBe(true);
  });
});

describe('mapMessage', () => {
  it('maps text message with ms date and public link', () => {
    const mapped = mapMessage(textMessage(), {
      chatUsername: 'newschannel',
      senderName: 'Ann',
      senderUsername: 'ann',
    });
    expect(mapped.text).toBe('Hello world');
    expect(mapped.date).toBe(1_700_000_000_000);
    expect(mapped.senderUserId).toBe(99);
    expect(mapped.link).toBe('https://t.me/newschannel/5');
  });

  it('maps media caption', () => {
    const msg = textMessage({
      content: {
        _: 'messagePhoto',
        photo: { _: 'photo', has_stickers: false, sizes: [] },
        caption: { _: 'formattedText', text: 'Photo caption', entities: [] },
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      },
    });
    expect(mapMessage(msg).text).toBe('Photo caption');
  });

  it('maps channel post sender chat', () => {
    const msg = textMessage({
      sender_id: { _: 'messageSenderChat', chat_id: -100123 },
    });
    const ids = senderIdsFromMessage(msg);
    expect(ids.senderUserId).toBeNull();
    expect(ids.senderChatId).toBe(-100123);
    const mapped = mapMessage(msg, { senderName: 'News' });
    expect(mapped.senderUserId).toBeNull();
    expect(mapped.senderChatId).toBe(-100123);
    expect(mapped.senderName).toBe('News');
  });
});

describe('buildPublicMessageLink', () => {
  it('returns null without username', () => {
    expect(buildPublicMessageLink(null, 100)).toBeNull();
  });
});

describe('extractMessageText', () => {
  it('returns empty for media without caption', () => {
    expect(
      extractMessageText({
        _: 'messagePhoto',
        photo: { _: 'photo', has_stickers: false, sizes: [] },
        caption: { _: 'formattedText', text: '', entities: [] },
        show_caption_above_media: false,
        has_spoiler: false,
        is_secret: false,
      }),
    ).toBe('');
  });
});

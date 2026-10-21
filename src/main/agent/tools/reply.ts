import type { AgentTool, ToolContext } from '../types';
import { sendMessage, sendVoiceMessage } from '../../pipeline/outreach';
import type { ToolHostDeps } from './deps';

export function createReplyTool(deps: ToolHostDeps): AgentTool {
  return {
    name: 'reply',
    description:
      'Отправить финальное сообщение клиенту в Telegram. Вызывай один раз за ход; voice=true — голосовое (если доступно).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Текст ответа клиенту' },
        voice: { type: 'boolean', description: 'Отправить голосом вместо текста' },
      },
      required: ['text'],
    },
    async run(args, ctx) {
      const text = String(args.text ?? '').trim();
      if (!text) return 'Ошибка: пустой текст';
      if (deps.turnState.replyUsed) return 'Ошибка: reply уже вызван в этом ходе';
      deps.turnState.replyUsed = true;
      deps.turnState.replyText = text;
      deps.turnState.replyVoice = !!args.voice;
      if (ctx.dryRun) return `[dryRun] Отправили бы клиенту: ${text.slice(0, 200)}`;
      const voice = !!args.voice && deps.speech;
      if (voice) {
        await sendVoiceMessage(deps, ctx.leadId, text, 'dm', true);
      } else {
        await sendMessage(deps, ctx.leadId, text, 'dm', true);
      }
      return 'Сообщение отправлено';
    },
  };
}

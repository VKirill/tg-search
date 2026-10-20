import type { AppEvent } from '../../shared/types';
import type { SpeechService } from '../ai/speech';
import { storeMediaCopy } from '../media';
import type { TelegramEngine, TgMessage } from '../telegram/types';

export const VOICE_TRANSCRIPT_FAILED = '[голосовое, не удалось расшифровать]';

export async function transcribeIncomingVoice(
  deps: {
    dataDir: string;
    engine: TelegramEngine;
    speech: SpeechService;
    accountId: number;
    msg: TgMessage;
    emit?: (e: AppEvent) => void;
    projectId?: number;
  },
): Promise<{ text: string; mediaPath: string; durationSec: number }> {
  const voice = deps.msg.voice;
  if (!voice) throw new Error('not a voice message');
  const downloaded = await deps.engine.downloadFile(deps.accountId, voice.fileId);
  const mediaPath = storeMediaCopy(deps.dataDir, downloaded, `in-${deps.msg.chatId}-${deps.msg.messageId}`);
  try {
    const text = await deps.speech.transcribe(mediaPath);
    return { text, mediaPath, durationSec: voice.durationSec };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (deps.emit && deps.projectId != null) {
      deps.emit({
        type: 'job',
        projectId: deps.projectId,
        stage: 'Расшифровка голосового',
        done: true,
        error,
      });
    }
    return { text: VOICE_TRANSCRIPT_FAILED, mediaPath, durationSec: voice.durationSec };
  }
}

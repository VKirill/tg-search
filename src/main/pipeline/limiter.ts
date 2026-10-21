import type { Account } from '../../shared/types';

export type CanSendResult =
  | { ok: true }
  | { ok: false; reason: 'daily' | 'pause'; waitMs?: number };

export function todayLocal(now: number): string {
  const d = new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function effectiveSentToday(account: Account, now: number): number {
  const today = todayLocal(now);
  return account.sentDay === today ? account.sentToday : 0;
}

// The daily cap guards first messages to strangers (what Telegram bans for); a reply to someone who wrote first, or to
// a trusted contact, only keeps the pause between messages
export function canSend(account: Account, now: number, reply = false): CanSendResult {
  if (!reply && effectiveSentToday(account, now) >= account.dailyLimit) {
    return { ok: false, reason: 'daily' };
  }
  if (account.lastSentAt != null) {
    const waitMs = account.pauseSec * 1000 - (now - account.lastSentAt);
    if (waitMs > 0) return { ok: false, reason: 'pause', waitMs };
  }
  return { ok: true };
}

export function afterSend(account: Account, now: number, reply = false): Partial<Account> {
  if (reply) return { lastSentAt: now };
  const today = todayLocal(now);
  const sentToday = account.sentDay === today ? account.sentToday + 1 : 1;
  return { sentToday, sentDay: today, lastSentAt: now };
}

export function limiterErrorMessage(r: { reason: 'daily' | 'pause'; waitMs?: number }): string {
  if (r.reason === 'daily') return 'Дневной лимит аккаунта исчерпан';
  const sec = Math.ceil((r.waitMs ?? 0) / 1000);
  return `Пауза между отправками: ещё ${sec} с`;
}

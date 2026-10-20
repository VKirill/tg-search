import type { AppEvent, Lead } from '../../shared/types';
import type { Db } from '../db';
import type { LeadAi } from '../ai/types';
import type { SpeechService } from '../ai/speech';
import type { TelegramEngine, TgMessage } from '../telegram/types';
import { listAuthorizedProjectAccounts } from './accounts';
import { afterSend, canSend, limiterErrorMessage } from './limiter';
import { maybeStartChainAfterFirstSend } from './sequence';

export interface OutreachDeps {
  db: Db;
  engine: TelegramEngine;
  ai: LeadAi;
  speech?: SpeechService;
  emit: (e: AppEvent) => void;
}

function pickSendingAccount(
  db: Db,
  projectAccountIds: number[],
  lead: Lead,
  now: number,
): { accountId: number } {
  const accounts = listAuthorizedProjectAccounts(db, projectAccountIds);
  const ordered = [...accounts].sort((a, b) => {
    if (a.id === lead.accountId) return -1;
    if (b.id === lead.accountId) return 1;
    return 0;
  });
  let lastFail: { reason: 'daily' | 'pause'; waitMs?: number } = { reason: 'daily' };
  for (const a of ordered) {
    const r = canSend(a, now);
    if (r.ok) return { accountId: a.id };
    lastFail = r;
  }
  throw new Error(limiterErrorMessage(lastFail));
}

async function dmChatId(deps: OutreachDeps, accountId: number, lead: Lead): Promise<number> {
  if (lead.authorUserId == null) throw new Error('Контакт не определён — ответьте в чате');
  return deps.engine.ensurePrivateChat(accountId, lead.authorUserId);
}

async function sendVoiceViaEngine(
  deps: OutreachDeps,
  accountId: number,
  lead: Lead,
  where: 'dm' | 'chat',
  filePath: string,
  durationSec: number,
  joinIfNeeded: boolean,
): Promise<TgMessage> {
  if (where === 'dm') {
    const chatId = await dmChatId(deps, accountId, lead);
    return deps.engine.sendVoice(accountId, chatId, filePath, durationSec);
  }
  try {
    return await deps.engine.sendVoice(
      accountId,
      lead.tgChatId,
      filePath,
      durationSec,
      lead.tgMessageId,
    );
  } catch (err) {
    if (!joinIfNeeded) throw err;
    await deps.engine.joinChat(accountId, lead.tgChatId);
    return deps.engine.sendVoice(accountId, lead.tgChatId, filePath, durationSec, lead.tgMessageId);
  }
}

async function sendViaEngine(
  deps: OutreachDeps,
  accountId: number,
  lead: Lead,
  where: 'dm' | 'chat',
  text: string,
  joinIfNeeded: boolean,
): Promise<TgMessage> {
  if (where === 'dm') {
    if (lead.authorUserId == null) throw new Error('Контакт не определён — ответьте в чате');
    return deps.engine.sendDirect(accountId, lead.authorUserId, text);
  }
  try {
    return await deps.engine.replyInChat(accountId, lead.tgChatId, lead.tgMessageId, text);
  } catch (err) {
    if (!joinIfNeeded) throw err;
    await deps.engine.joinChat(accountId, lead.tgChatId);
    return deps.engine.replyInChat(accountId, lead.tgChatId, lead.tgMessageId, text);
  }
}

export async function draftReply(deps: OutreachDeps, leadId: number, where?: 'dm' | 'chat'): Promise<string> {
  const lead = deps.db.getLead(leadId);
  const project = deps.db.getProject(lead.projectId);
  where ??= project.autopilot.replyTarget;
  const history = deps.db.listMessages(leadId).map((m) => ({ direction: m.direction, text: m.text }));
  return deps.ai.draftReply(project, lead, where, history);
}

export async function sendMessage(
  deps: OutreachDeps,
  leadId: number,
  text: string,
  where: 'dm' | 'chat',
  auto = false,
): Promise<import('../../shared/types').ChatMessage> {
  const lead = deps.db.getLead(leadId);
  const project = deps.db.getProject(lead.projectId);
  const now = Date.now();
  const { accountId } = pickSendingAccount(deps.db, project.accountIds, lead, now);

  const tgMsg = await sendViaEngine(deps, accountId, lead, where, text, project.autopilot.joinIfNeeded);

  const message = deps.db.addMessage({
    leadId,
    accountId,
    direction: 'out',
    where,
    text,
    tgChatId: tgMsg.chatId,
    tgMessageId: tgMsg.messageId,
    date: tgMsg.date,
    auto,
  });

  const updatedLead = deps.db.updateLead(leadId, { status: 'replied', accountId });
  if (lead.sequenceStep === 0) maybeStartChainAfterFirstSend(deps.db, leadId, now);
  const account = deps.db.getAccount(accountId);
  const patched = deps.db.updateAccount(accountId, afterSend(account, now));

  deps.emit({ type: 'message:new', message });
  deps.emit({ type: 'lead:update', lead: updatedLead });
  deps.emit({ type: 'account:update', account: patched });
  return message;
}

export async function sendVoiceMessage(
  deps: OutreachDeps,
  leadId: number,
  text: string,
  where: 'dm' | 'chat',
  auto = false,
): Promise<import('../../shared/types').ChatMessage> {
  if (!deps.speech) throw new Error('Голосовые сообщения не настроены');
  const lead = deps.db.getLead(leadId);
  const project = deps.db.getProject(lead.projectId);
  const now = Date.now();
  const { accountId } = pickSendingAccount(deps.db, project.accountIds, lead, now);

  const { path: filePath, durationSec } = await deps.speech.synthesize(text);
  const tgMsg = await sendVoiceViaEngine(
    deps,
    accountId,
    lead,
    where,
    filePath,
    durationSec,
    project.autopilot.joinIfNeeded,
  );

  const message = deps.db.addMessage({
    leadId,
    accountId,
    direction: 'out',
    where,
    kind: 'voice',
    text,
    mediaPath: filePath,
    durationSec,
    tgChatId: tgMsg.chatId,
    tgMessageId: tgMsg.messageId,
    date: tgMsg.date,
    auto,
  });

  const updatedLead = deps.db.updateLead(leadId, { status: 'replied', accountId });
  if (lead.sequenceStep === 0) maybeStartChainAfterFirstSend(deps.db, leadId, now);
  const account = deps.db.getAccount(accountId);
  const patched = deps.db.updateAccount(accountId, afterSend(account, now));

  deps.emit({ type: 'message:new', message });
  deps.emit({ type: 'lead:update', lead: updatedLead });
  deps.emit({ type: 'account:update', account: patched });
  return message;
}

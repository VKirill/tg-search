import type { Account, AppEvent, LoginState } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine } from '../telegram/types';

export interface AccountsDeps {
  db: Db;
  engine: TelegramEngine;
  emit: (e: AppEvent) => void;
}

export function listAuthorizedProjectAccounts(db: Db, accountIds: number[]): Account[] {
  const all = db.listAccounts().filter((a) => a.status === 'authorized');
  const idSet = new Set(accountIds);
  const project = all.filter((a) => idSet.has(a.id));
  return project.length > 0 ? project : all;
}

async function finalizeAuthorized(deps: AccountsDeps, accountId: number): Promise<Account> {
  const me = await deps.engine.getMe(accountId);
  let account = deps.db.updateAccount(accountId, {
    tgUserId: me.userId,
    username: me.username,
    firstName: me.firstName,
    lastName: me.lastName,
    photoPath: me.photoPath,
    status: 'authorized',
  });
  const hasPrimary = deps.db.listAccounts().some((a) => a.isPrimary);
  if (!hasPrimary) {
    account = deps.db.updateAccount(accountId, { isPrimary: true });
  }
  deps.emit({ type: 'account:update', account });
  return account;
}

async function applyLoginResult(
  deps: AccountsDeps,
  accountId: number,
  result: { status: Account['status']; error?: string },
): Promise<LoginState> {
  let account = deps.db.updateAccount(accountId, { status: result.status });
  if (result.status === 'authorized') {
    account = await finalizeAuthorized(deps, accountId);
  } else {
    deps.emit({ type: 'account:update', account });
  }
  return { accountId, status: account.status, error: result.error };
}

export async function startLogin(deps: AccountsDeps, phone: string): Promise<LoginState> {
  const account = deps.db.upsertAccountByPhone(phone);
  const result = await deps.engine.startLogin(account.id, phone);
  return applyLoginResult(deps, account.id, result);
}

export async function submitCode(deps: AccountsDeps, accountId: number, code: string): Promise<LoginState> {
  const result = await deps.engine.submitCode(accountId, code);
  return applyLoginResult(deps, accountId, result);
}

export async function submitPassword(deps: AccountsDeps, accountId: number, password: string): Promise<LoginState> {
  const result = await deps.engine.submitPassword(accountId, password);
  return applyLoginResult(deps, accountId, result);
}

export async function updateAccount(
  deps: AccountsDeps,
  accountId: number,
  patch: Partial<Pick<Account, 'dailyLimit' | 'pauseSec' | 'isPrimary'>>,
): Promise<Account> {
  const account = deps.db.updateAccount(accountId, patch);
  deps.emit({ type: 'account:update', account });
  return account;
}

export async function removeAccount(deps: AccountsDeps, accountId: number): Promise<void> {
  try {
    await deps.engine.logout(accountId);
  } catch {
    // ignore logout errors
  }
  deps.db.removeAccount(accountId);
  for (const p of deps.db.listProjects()) {
    if (p.accountIds.includes(accountId)) {
      deps.db.updateProject(p.id, { accountIds: p.accountIds.filter((id) => id !== accountId) });
    }
  }
}

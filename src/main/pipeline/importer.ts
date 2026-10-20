import type { AppEvent, ImportResult } from '../../shared/types';
import type { Db } from '../db';
import type { TelegramEngine, TgChat } from '../telegram/types';
import { listAuthorizedProjectAccounts } from './accounts';

export interface ImporterDeps {
  db: Db;
  engine: TelegramEngine;
  emit: (e: AppEvent) => void;
}

type JoinTask = { accountId: number; chatId: number; sourceId: number };

const LINK_RE =
  /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:joinchat\/|\+)?[\w-]+|@?[\w][\w\d_]{3,}$/i;

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parseCsvRows(csv: string): string[][] {
  const text = stripBom(csv).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === '\n') {
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    if (c === ',' || c === ';') {
      row.push(cell);
      cell = '';
      continue;
    }
    cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function looksLikeLink(cell: string): boolean {
  const v = cell.trim();
  if (!v) return false;
  return LINK_RE.test(v) || v.includes('t.me/') || v.startsWith('@');
}

export function parseCsvLinks(csv: string): string[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) return [];
  const start = rows[0].length > 0 && !looksLikeLink(rows[0][0]) ? 1 : 0;
  const out: string[] = [];
  const seen = new Set<string>();
  for (let r = start; r < rows.length; r++) {
    let raw = (rows[r][0] ?? '').trim();
    if (!raw && rows[r].length > 1) raw = rows[r].join(',').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function normalizeLink(value: string): string {
  const v = value.trim();
  if (v.startsWith('@')) return v;
  if (/^https?:\/\//i.test(v) || v.includes('t.me/')) return v;
  if (/^[\w][\w\d_]{3,}$/.test(v)) return `@${v}`;
  return v;
}

export function createImporter(deps: ImporterDeps) {
  const joinQueue: JoinTask[] = [];
  const joinNextAt = new Map<number, number>();
  let joinTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleJoinPump() {
    if (joinTimer) return;
    joinTimer = setTimeout(() => {
      joinTimer = null;
      void pumpJoin();
    }, 500);
  }

  async function pumpJoin() {
    if (joinQueue.length === 0) return;
    const now = Date.now();
    let picked = -1;
    for (let i = 0; i < joinQueue.length; i++) {
      const t = joinQueue[i];
      const next = joinNextAt.get(t.accountId) ?? 0;
      if (now >= next) {
        picked = i;
        break;
      }
    }
    if (picked < 0) {
      const earliest = Math.min(...joinQueue.map((t) => joinNextAt.get(t.accountId) ?? 0));
      joinTimer = setTimeout(() => {
        joinTimer = null;
        void pumpJoin();
      }, Math.max(100, earliest - now));
      return;
    }
    const task = joinQueue.splice(picked, 1)[0];
    const jitter = 90_000 + Math.floor(Math.random() * 30_001);
    try {
      await deps.engine.joinChat(task.accountId, task.chatId);
      const source = deps.db.updateSource(task.sourceId, { accountId: task.accountId });
      deps.emit({ type: 'source:update', source });
    } catch (e) {
      const retryAfter = (e as Error & { retryAfter?: number }).retryAfter;
      if (retryAfter != null && retryAfter > 0) {
        joinNextAt.set(task.accountId, Date.now() + retryAfter * 1000);
        joinQueue.push(task);
      }
    }
    joinNextAt.set(task.accountId, Date.now() + jitter);
    scheduleJoinPump();
  }

  function enqueueJoin(accountId: number, chatId: number, sourceId: number) {
    joinQueue.push({ accountId, chatId, sourceId });
    scheduleJoinPump();
  }

  async function importCsv(projectId: number, csv: string): Promise<ImportResult> {
    const project = deps.db.getProject(projectId);
    const accounts = listAuthorizedProjectAccounts(deps.db, project.accountIds);
    if (accounts.length === 0) throw new Error('Подключите рабочий аккаунт Telegram');

    const values = parseCsvLinks(csv);
    const failed: ImportResult['failed'] = [];
    let added = 0;
    let skipped = 0;
    let accountIdx = 0;

    for (let i = 0; i < values.length; i++) {
      const value = normalizeLink(values[i]);
      deps.emit({
        type: 'job',
        projectId,
        stage: `Импорт: ${i + 1} из ${values.length}`,
        done: false,
      });
      const account = accounts[accountIdx % accounts.length];
      accountIdx++;
      if (i > 0) await new Promise((r) => setTimeout(r, 1000));

      try {
        const chat: TgChat = await deps.engine.resolveChat(account.id, value);
        if (deps.db.findSource(projectId, chat.chatId)) {
          skipped++;
          continue;
        }
        const source = deps.db.addSource({
          projectId,
          tgChatId: chat.chatId,
          title: chat.title,
          username: chat.username,
          kind: chat.kind,
          memberCount: chat.memberCount,
          foundBy: 'csv',
          accountId: account.id,
          status: 'active',
        });
        deps.emit({ type: 'source:update', source });
        added++;
        if (!chat.isMember) enqueueJoin(account.id, chat.chatId, source.id);
      } catch (e) {
        failed.push({ value: values[i], error: e instanceof Error ? e.message : String(e) });
      }
    }

    deps.emit({
      type: 'job',
      projectId,
      stage: `Импорт: ${values.length} из ${values.length}`,
      done: true,
    });
    return { added, skipped, failed };
  }

  return { importCsv, stop() {
    if (joinTimer) clearTimeout(joinTimer);
    joinTimer = null;
    joinQueue.length = 0;
  } };
}

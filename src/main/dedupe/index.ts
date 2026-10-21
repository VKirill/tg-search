import type { AppEvent, Lead, SpamTemplate } from '../../shared/types';
import type { Db } from '../db';
import type { TgMessage } from '../telegram/types';
import {
  fingerprintText,
  isNearDuplicate,
  simhashFromDb,
  simhashToDb,
  type TextFingerprint,
} from './fingerprint';
import { ensureDedupeSchema } from './schema';

const REPEAT_WINDOW_MS = 30 * 86400_000;
const LEARN_WINDOW_MS = 14 * 86400_000;
const PRUNE_MS = 30 * 86400_000;
const PRUNE_INTERVAL_MS = 86400_000;
const FP_LOOKBACK_MS = 30 * 86400_000;
const MIN_SPAM_AUTHORS = 3;

export type DedupeVerdict =
  | { verdict: 'new' }
  | { verdict: 'repeat'; leadId: number }
  | { verdict: 'spam'; templateId: number };

export interface Dedupe {
  check(projectId: number, messages: TgMessage[]): DedupeVerdict[];
  learn(projectId: number, messages: TgMessage[]): void;
  messagesForQualify(projectId: number, messages: TgMessage[]): TgMessage[];
  markSpam(leadId: number): Lead;
  setTemplateStatus(id: number, status: SpamTemplate['status']): SpamTemplate;
  listTemplates(): SpamTemplate[];
}

type FpRow = {
  cluster_id: string;
  exact_hash: string;
  simhash: string;
  sample: string;
};

type TemplateRow = {
  id: number;
  sample: string;
  exact_hash: string;
  simhash: string;
  authors: number;
  messages: number;
  status: string;
  source: string;
  created_at: number;
  last_seen_at: number;
};

function toTemplate(r: TemplateRow): SpamTemplate {
  return {
    id: r.id,
    sample: r.sample,
    authors: r.authors,
    messages: r.messages,
    status: r.status as SpamTemplate['status'],
    source: r.source as SpamTemplate['source'],
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
  };
}

function templateFp(r: TemplateRow): TextFingerprint {
  const fp = fingerprintText(r.sample);
  return { ...fp, exactHash: r.exact_hash, simhash: simhashFromDb(r.simhash) };
}

export { PRUNE_INTERVAL_MS };

export function createDedupe(deps: { db: Db; emit: (e: AppEvent) => void }): Dedupe {
  const { db, emit } = deps;
  ensureDedupeSchema(db.raw);

  function listTemplateRows(): TemplateRow[] {
    return db.raw.prepare('SELECT * FROM spam_templates ORDER BY id').all() as TemplateRow[];
  }

  function findMatchingTemplate(fp: TextFingerprint, status?: SpamTemplate['status']): TemplateRow | undefined {
    for (const row of listTemplateRows()) {
      if (status && row.status !== status) continue;
      if (matchesTemplate(fp, row)) return row;
    }
    return undefined;
  }

  function matchesTemplate(fp: TextFingerprint, row: TemplateRow): boolean {
    const tpl: TextFingerprint = {
      normalized: fingerprintText(row.sample).normalized,
      exactHash: row.exact_hash,
      simhash: simhashFromDb(row.simhash),
      len: fingerprintText(row.sample).len,
    };
    return isNearDuplicate(fp, tpl);
  }

  function findClusterId(fp: TextFingerprint, sinceMs: number): string {
    const recent = db.raw.prepare(
      `SELECT cluster_id, exact_hash, simhash, sample FROM message_fingerprints
       WHERE created_at >= ? ORDER BY id DESC LIMIT 5000`,
    ).all(sinceMs) as FpRow[];
    for (const row of recent) {
      const other: TextFingerprint = {
        normalized: fingerprintText(row.sample).normalized,
        exactHash: row.exact_hash,
        simhash: simhashFromDb(row.simhash),
        len: fingerprintText(row.sample).len,
      };
      if (isNearDuplicate(fp, other)) return row.cluster_id;
    }
    return fp.exactHash;
  }

  function findRepeatLead(projectId: number, senderUserId: number, fp: TextFingerprint): Lead | undefined {
    const since = Date.now() - REPEAT_WINDOW_MS;
    const rows = db.raw.prepare(
      `SELECT * FROM leads WHERE project_id = ? AND author_user_id = ? AND date >= ? ORDER BY date DESC`,
    ).all(projectId, senderUserId, since) as Record<string, unknown>[];
    for (const r of rows) {
      const leadFp = fingerprintText(String(r.text));
      if (isNearDuplicate(fp, leadFp)) {
        return {
          id: r.id as number,
          projectId: r.project_id as number,
          sourceId: r.source_id as number | null,
          tgChatId: r.tg_chat_id as number,
          tgMessageId: r.tg_message_id as number,
          authorUserId: r.author_user_id as number | null,
          authorName: r.author_name as string | null,
          authorUsername: r.author_username as string | null,
          text: r.text as string,
          date: r.date as number,
          link: r.link as string | null,
          score: r.score as number,
          label: r.label as Lead['label'],
          reason: r.reason as string,
          feedback: r.feedback as Lead['feedback'],
          status: r.status as Lead['status'],
          accountId: r.account_id as number | null,
          clientId: (r.client_id as number | null) ?? null,
          repeatCount: (r.repeat_count as number) ?? 0,
          spamTemplateId: (r.spam_template_id as number | null) ?? null,
          sequenceStep: r.sequence_step as number,
          nextStepAt: r.next_step_at as number | null,
          handoff: !!r.handoff,
          handoffReason: r.handoff_reason as string | null,
          createdAt: r.created_at as number,
        };
      }
    }
    return undefined;
  }

  function bumpRepeat(leadId: number, newDate: number): Lead {
    db.raw.prepare('UPDATE leads SET repeat_count = repeat_count + 1, date = ? WHERE id = ?').run(newDate, leadId);
    return db.getLead(leadId);
  }

  function hideLeadsForTemplate(templateId: number, fp: TextFingerprint) {
    const leads = db.raw.prepare('SELECT id, text FROM leads WHERE status != ?').all('hidden') as { id: number; text: string }[];
    const stmt = db.raw.prepare('UPDATE leads SET status = ?, spam_template_id = ? WHERE id = ?');
    for (const l of leads) {
      if (isNearDuplicate(fp, fingerprintText(l.text))) {
        stmt.run('hidden', templateId, l.id);
        emit({ type: 'lead:update', lead: db.getLead(l.id) });
      }
    }
  }

  function upsertTemplate(fp: TextFingerprint, sample: string, source: SpamTemplate['source'], status: SpamTemplate['status']): TemplateRow {
    const existing = findMatchingTemplate(fp);
    const now = Date.now();
    if (existing) {
      db.raw.prepare(
        'UPDATE spam_templates SET messages = messages + 1, last_seen_at = ?, sample = ?, status = ?, source = ? WHERE id = ?',
      ).run(now, sample, status, source, existing.id);
      return db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(existing.id) as TemplateRow;
    }
    const res = db.raw.prepare(
      `INSERT INTO spam_templates(sample, exact_hash, simhash, authors, messages, status, source, created_at, last_seen_at)
       VALUES(?, ?, ?, 0, 1, ?, ?, ?, ?)`,
    ).run(sample, fp.exactHash, simhashToDb(fp.simhash), status, source, now, now);
    return db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(Number(res.lastInsertRowid)) as TemplateRow;
  }

  function refreshTemplateAuthors(templateId: number, clusterId: string) {
    const since = Date.now() - LEARN_WINDOW_MS;
    const row = db.raw.prepare(
      `SELECT COUNT(DISTINCT sender_user_id) AS n FROM fingerprint_cluster_authors
       WHERE cluster_id = ? AND last_seen_at >= ? AND sender_user_id IS NOT NULL`,
    ).get(clusterId, since) as { n: number };
    db.raw.prepare('UPDATE spam_templates SET authors = ? WHERE id = ?').run(row.n, templateId);
  }

  function maybeAutoSpam(clusterId: string, fp: TextFingerprint, sample: string) {
    if (findMatchingTemplate(fp, 'allowed')) return;
    const since = Date.now() - LEARN_WINDOW_MS;
    const row = db.raw.prepare(
      `SELECT COUNT(DISTINCT sender_user_id) AS n FROM fingerprint_cluster_authors
       WHERE cluster_id = ? AND last_seen_at >= ? AND sender_user_id IS NOT NULL`,
    ).get(clusterId, since) as { n: number };
    if (row.n < MIN_SPAM_AUTHORS) return;
    const tpl = upsertTemplate(fp, sample, 'auto', 'spam');
    refreshTemplateAuthors(tpl.id, clusterId);
    hideLeadsForTemplate(tpl.id, fp);
  }

  function indexMessage(m: TgMessage) {
    const exists = db.raw.prepare(
      'SELECT 1 FROM message_fingerprints WHERE tg_chat_id = ? AND tg_message_id = ?',
    ).get(m.chatId, m.messageId);
    if (exists) return;

    const fp = fingerprintText(m.text);
    const since = Date.now() - FP_LOOKBACK_MS;
    const clusterId = findClusterId(fp, since);
    const now = Date.now();
    db.raw.prepare(
      `INSERT INTO message_fingerprints(tg_chat_id, tg_message_id, sender_user_id, cluster_id, exact_hash, simhash, sample, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(m.chatId, m.messageId, m.senderUserId, clusterId, fp.exactHash, simhashToDb(fp.simhash), m.text.slice(0, 500), now);

    if (m.senderUserId != null) {
      db.raw.prepare(
        `INSERT INTO fingerprint_cluster_authors(cluster_id, sender_user_id, first_seen_at, last_seen_at)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(cluster_id, sender_user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      ).run(clusterId, m.senderUserId, now, now);
    }

    maybeAutoSpam(clusterId, fp, m.text);
  }

  return {
    check(projectId: number, messages: TgMessage[]): DedupeVerdict[] {
      return messages.map((m) => {
        const fp = fingerprintText(m.text);
        const spamTpl = findMatchingTemplate(fp, 'spam');
        if (spamTpl) return { verdict: 'spam', templateId: spamTpl.id };
        if (m.senderUserId != null) {
          const lead = findRepeatLead(projectId, m.senderUserId, fp);
          if (lead) {
            const updated = bumpRepeat(lead.id, m.date);
            emit({ type: 'lead:update', lead: updated });
            return { verdict: 'repeat', leadId: lead.id };
          }
        }
        return { verdict: 'new' };
      });
    },

    learn(_projectId: number, messages: TgMessage[]) {
      for (const m of messages) indexMessage(m);
    },

    messagesForQualify(projectId: number, messages: TgMessage[]): TgMessage[] {
      const verdicts = this.check(projectId, messages);
      return messages.filter((_, i) => verdicts[i].verdict === 'new');
    },

    markSpam(leadId: number): Lead {
      const lead = db.getLead(leadId);
      const fp = fingerprintText(lead.text);
      const tpl = upsertTemplate(fp, lead.text, 'owner', 'spam');
      const clusterId = findClusterId(fp, Date.now() - FP_LOOKBACK_MS);
      refreshTemplateAuthors(tpl.id, clusterId);
      hideLeadsForTemplate(tpl.id, fp);
      db.raw.prepare('UPDATE leads SET status = ?, spam_template_id = ? WHERE id = ?').run('hidden', tpl.id, leadId);
      const updated = db.getLead(leadId);
      emit({ type: 'lead:update', lead: updated });
      return updated;
    },

    setTemplateStatus(id: number, status: SpamTemplate['status']): SpamTemplate {
      const row = db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(id) as TemplateRow | undefined;
      if (!row) throw new Error(`spam template ${id} not found`);
      db.raw.prepare('UPDATE spam_templates SET status = ? WHERE id = ?').run(status, id);
      if (status === 'allowed') {
        const leads = db.raw.prepare('SELECT id FROM leads WHERE spam_template_id = ? AND status = ?').all(id, 'hidden') as { id: number }[];
        for (const l of leads) {
          db.raw.prepare('UPDATE leads SET status = ?, spam_template_id = NULL WHERE id = ?').run('new', l.id);
          emit({ type: 'lead:update', lead: db.getLead(l.id) });
        }
      } else if (status === 'spam') {
        const fp = templateFp(row);
        hideLeadsForTemplate(id, fp);
      }
      return toTemplate(db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(id) as TemplateRow);
    },

    listTemplates(): SpamTemplate[] {
      return listTemplateRows().map(toTemplate);
    },
  };
}

export function pruneFingerprints(db: Db) {
  ensureDedupeSchema(db.raw);
  const cutoff = Date.now() - PRUNE_MS;
  db.raw.prepare('DELETE FROM message_fingerprints WHERE created_at < ?').run(cutoff);
}

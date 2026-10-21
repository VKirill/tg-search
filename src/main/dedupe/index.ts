import type { AppEvent, Lead, SpamTemplate } from '../../shared/types';
import type { Db } from '../db';
import type { TgMessage } from '../telegram/types';
import {
  fingerprintText,
  isNearDuplicate,
  isSameTemplate,
  simhashFromDb,
  tooShortForSpam,
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
  learnExistingLeads(): void; // leads found before dedupe existed join the clusters once
  messagesForQualify(projectId: number, messages: TgMessage[]): TgMessage[];
  markSpam(leadId: number): Lead;
  setTemplateStatus(id: number, status: SpamTemplate['status']): SpamTemplate;
  listTemplates(): SpamTemplate[];
}

type FpRow = {
  id: number;
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
  cluster_id: string | null;
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
    if (tooShortForSpam(fp) || tooShortForSpam(templateFp(row))) return false;
    if (isSameTemplate(fp, templateFp(row))) return true;
    if (!row.cluster_id) return false;
    const variants = db.raw.prepare('SELECT sample FROM message_fingerprints WHERE cluster_id = ? ORDER BY id DESC LIMIT 50')
      .all(row.cluster_id) as { sample: string }[];
    return variants.some((v) => isSameTemplate(fp, fingerprintText(v.sample)));
  }

  // Fingerprints of stored rows, so a batch does not re-normalize thousands of samples per message
  const storedFps = new Map<number, TextFingerprint>();
  function storedFp(row: FpRow): TextFingerprint {
    let fp = storedFps.get(row.id);
    if (!fp) {
      if (storedFps.size > 20_000) storedFps.clear();
      fp = { ...fingerprintText(row.sample), exactHash: row.exact_hash, simhash: simhashFromDb(row.simhash) };
      storedFps.set(row.id, fp);
    }
    return fp;
  }

  // Single linkage: a text that matches several clusters joins them, so a spun campaign ends up as one cluster
  function findClusterId(fp: TextFingerprint, sinceMs: number): string {
    const recent = db.raw.prepare(
      `SELECT id, cluster_id, exact_hash, simhash, sample FROM message_fingerprints
       WHERE created_at >= ? ORDER BY id DESC LIMIT 5000`,
    ).all(sinceMs) as FpRow[];
    const clusters: string[] = [];
    for (const row of recent) {
      if (!clusters.includes(row.cluster_id) && isSameTemplate(fp, storedFp(row))) clusters.push(row.cluster_id);
    }
    if (clusters.length === 0) return fp.exactHash;
    const [keep, ...rest] = clusters;
    for (const c of rest) mergeCluster(c, keep);
    return keep;
  }

  function mergeCluster(from: string, into: string) {
    db.raw.prepare('UPDATE message_fingerprints SET cluster_id = ? WHERE cluster_id = ?').run(into, from);
    db.raw.prepare(
      `INSERT INTO fingerprint_cluster_authors(cluster_id, sender_user_id, first_seen_at, last_seen_at)
       SELECT ?, sender_user_id, first_seen_at, last_seen_at FROM fingerprint_cluster_authors WHERE cluster_id = ?
       ON CONFLICT(cluster_id, sender_user_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
    ).run(into, from);
    db.raw.prepare('DELETE FROM fingerprint_cluster_authors WHERE cluster_id = ?').run(from);
    db.raw.prepare('UPDATE spam_templates SET cluster_id = ? WHERE cluster_id = ?').run(into, from);
  }

  function findRepeatLead(projectId: number, senderUserId: number, fp: TextFingerprint, beforeId = Number.MAX_SAFE_INTEGER): Lead | undefined {
    const since = Date.now() - REPEAT_WINDOW_MS;
    const rows = db.raw.prepare(
      `SELECT * FROM leads WHERE project_id = ? AND author_user_id = ? AND date >= ? AND id < ? ORDER BY date DESC`,
    ).all(projectId, senderUserId, since, beforeId) as Record<string, unknown>[];
    for (const r of rows) {
      const leadFp = fingerprintText(String(r.text));
      if (isNearDuplicate(fp, leadFp)) return db.getLead(r.id as number);
    }
    return undefined;
  }

  function bumpRepeat(leadId: number, newDate: number): Lead {
    db.raw.prepare('UPDATE leads SET repeat_count = repeat_count + 1, date = ? WHERE id = ?').run(newDate, leadId);
    return db.getLead(leadId);
  }

  function hideLeadsForTemplate(templateId: number) {
    const row = db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(templateId) as TemplateRow;
    const leads = db.raw.prepare('SELECT id, text FROM leads WHERE status != ?').all('hidden') as { id: number; text: string }[];
    const stmt = db.raw.prepare('UPDATE leads SET status = ?, spam_template_id = ? WHERE id = ?');
    for (const l of leads) {
      if (matchesTemplate(fingerprintText(l.text), row)) {
        stmt.run('hidden', templateId, l.id);
        emit({ type: 'lead:update', lead: db.getLead(l.id) });
      }
    }
  }

  function upsertTemplate(
    fp: TextFingerprint, sample: string, source: SpamTemplate['source'], status: SpamTemplate['status'], clusterId: string,
  ): TemplateRow {
    const existing = db.raw.prepare('SELECT * FROM spam_templates WHERE cluster_id = ?').get(clusterId) as TemplateRow | undefined
      ?? findMatchingTemplate(fp);
    const now = Date.now();
    if (existing) {
      db.raw.prepare(
        'UPDATE spam_templates SET messages = messages + 1, last_seen_at = ?, sample = ?, status = ?, source = ?, cluster_id = ? WHERE id = ?',
      ).run(now, sample, status, source, existing.cluster_id ?? clusterId, existing.id);
      return db.raw.prepare('SELECT * FROM spam_templates WHERE id = ?').get(existing.id) as TemplateRow;
    }
    const res = db.raw.prepare(
      `INSERT INTO spam_templates(sample, exact_hash, simhash, authors, messages, status, source, created_at, last_seen_at, cluster_id)
       VALUES(?, ?, ?, 0, 1, ?, ?, ?, ?, ?)`,
    ).run(sample, fp.exactHash, simhashToDb(fp.simhash), status, source, now, now, clusterId);
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
    const known = db.raw.prepare('SELECT status FROM spam_templates WHERE cluster_id = ?').get(clusterId) as { status: string } | undefined;
    if (known?.status === 'allowed') return;
    const tpl = upsertTemplate(fp, sample, 'auto', 'spam', clusterId);
    refreshTemplateAuthors(tpl.id, clusterId);
    hideLeadsForTemplate(tpl.id);
  }

  function indexMessage(m: TgMessage) {
    const exists = db.raw.prepare(
      'SELECT 1 FROM message_fingerprints WHERE tg_chat_id = ? AND tg_message_id = ?',
    ).get(m.chatId, m.messageId);
    if (exists) return;

    const fp = fingerprintText(m.text);
    if (tooShortForSpam(fp)) return; // nothing left to compare
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

    learnExistingLeads() {
      // a re-post by the same author that nobody answered folds into the first lead, as it would have live
      const fresh = db.raw.prepare("SELECT id FROM leads WHERE status = 'new' AND author_user_id IS NOT NULL ORDER BY id").all() as { id: number }[];
      for (const { id } of fresh) {
        const l = db.getLead(id);
        if (l.status !== 'new') continue;
        const first = findRepeatLead(l.projectId, l.authorUserId!, fingerprintText(l.text), l.id);
        if (!first) continue;
        emit({ type: 'lead:update', lead: bumpRepeat(first.id, Math.max(first.date, l.date)) });
        emit({ type: 'lead:update', lead: db.setLeadStatus(l.id, 'hidden') });
      }
      const leads = db.raw.prepare(
        `SELECT * FROM leads l WHERE NOT EXISTS (SELECT 1 FROM message_fingerprints f
           WHERE f.tg_chat_id = l.tg_chat_id AND f.tg_message_id = l.tg_message_id) ORDER BY id`,
      ).all() as Record<string, unknown>[];
      for (const r of leads) {
        const l = db.getLead(r.id as number);
        indexMessage({
          chatId: l.tgChatId, messageId: l.tgMessageId, date: l.date, text: l.text, senderUserId: l.authorUserId,
          senderChatId: null, senderName: l.authorName, senderUsername: l.authorUsername, senderIsBot: false, voice: null,
          photo: null, document: null, replyToMessageId: null, link: l.link, isOutgoing: false,
        });
      }
    },

    messagesForQualify(projectId: number, messages: TgMessage[]): TgMessage[] {
      const verdicts = this.check(projectId, messages);
      return messages.filter((_, i) => verdicts[i].verdict === 'new');
    },

    markSpam(leadId: number): Lead {
      const lead = db.getLead(leadId);
      const fp = fingerprintText(lead.text);
      const clusterId = findClusterId(fp, Date.now() - FP_LOOKBACK_MS);
      const tpl = upsertTemplate(fp, lead.text, 'owner', 'spam', clusterId);
      refreshTemplateAuthors(tpl.id, clusterId);
      hideLeadsForTemplate(tpl.id);
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
        hideLeadsForTemplate(id);
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

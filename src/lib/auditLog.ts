import type pg from 'pg';

// The audit trail (CLAUDE.md invariant 5, db/migrations/001_init.sql `audit_log`).
// Every reveal of a beneficiary contact writes one row here: WHO revealed, WHAT
// action, and WHICH need — never the number itself (the plaintext lives only in the
// contact_vault and is surfaced only in the ephemeral shown to the clicking user).
// The table is append-only (a DB trigger forbids update/delete), so this seam only
// ever inserts. Two impls: InMemoryAuditLog (hermetic tests + demo) and PgAuditLog
// (production) — higher layers depend only on the interface.

/** One audit entry. `meta` carries derived, non-PII context only. */
export interface AuditEntry {
  /** The Slack user id that performed the action (the actor). */
  actorId: string;
  /** A stable action verb, e.g. 'contact_revealed'. */
  action: string;
  /** The subject the action was performed on (e.g. a need id). */
  subject: string;
  /** Optional derived context — must never contain PII. */
  meta?: Record<string, unknown>;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** Hermetic audit log — keeps entries in memory for assertions and the demo. */
export class InMemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async record(entry: AuditEntry): Promise<void> {
    this.entries.push({ ...entry, meta: entry.meta ? { ...entry.meta } : undefined });
  }
}

/** Production audit log — inserts into the append-only `audit_log` table. */
export class PgAuditLog implements AuditLog {
  constructor(private readonly pool: pg.Pool) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.pool.query('INSERT INTO audit_log (actor_id, action, subject, meta) VALUES ($1, $2, $3, $4)', [
      entry.actorId,
      entry.action,
      entry.subject,
      JSON.stringify(entry.meta ?? {}),
    ]);
  }
}

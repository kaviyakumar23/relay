import type pg from 'pg';

// Transport-level Slack event dedupe (BUILD-DOC §9.2 rule 2, CLAUDE.md invariant
// #7 layer 1). Slack re-delivers events on ack timeouts; we must process each
// delivery at most once. This is the FIRST of two idempotency layers — the second
// is the deterministic business key on need_events (src/ledger/idempotency.ts),
// which catches duplicates even when a retry arrives with a fresh envelope id.

export interface DedupeStore {
  /**
   * Atomically record a Slack event id. Returns true if this id is NEW (the caller
   * should process the event) and false if it was already seen (a duplicate
   * delivery the caller must skip).
   */
  markSeen(eventId: string): Promise<boolean>;
}

/** In-memory dedupe (hermetic tests + demo). A Set is enough within one process. */
export class MemoryDedupeStore implements DedupeStore {
  private readonly seen = new Set<string>();

  async markSeen(eventId: string): Promise<boolean> {
    if (this.seen.has(eventId)) return false;
    this.seen.add(eventId);
    return true;
  }
}

/**
 * Postgres dedupe against the `slack_events` table (event_id PRIMARY KEY). The
 * INSERT ... ON CONFLICT DO NOTHING is atomic, so concurrent redeliveries race
 * safely: exactly one INSERT returns a row (fresh), the rest conflict (duplicate).
 */
export class PgDedupeStore implements DedupeStore {
  constructor(private readonly pool: pg.Pool) {}

  async markSeen(eventId: string): Promise<boolean> {
    const res = await this.pool.query(
      'INSERT INTO slack_events (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING',
      [eventId],
    );
    return (res.rowCount ?? 0) > 0;
  }
}

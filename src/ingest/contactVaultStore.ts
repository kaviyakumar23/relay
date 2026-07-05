import type pg from 'pg';
import { logger } from '../lib/logger';
import { type ContactVault, decryptContact, encryptContact, InMemoryContactVault } from '../lib/vault';

// Storage adapters for the encrypted contact vault (CLAUDE.md invariant 5). The
// crypto + interface + in-memory impl live in src/lib/vault.ts; this module adds the
// Postgres-backed store and a small factory that degrades gracefully when no key is
// configured. Beneficiary PII (a phone number) lives ONLY here, AES-256-GCM
// encrypted; a reveal button writes an audit_log row (later phase). The plaintext
// never enters a need row, an event payload, a log line, or an LLM input.

export type { ContactVault };
export { InMemoryContactVault };

/**
 * Postgres contact vault backed by the `contact_vault` table
 * (need_id PK, encrypted_payload bytea; db/migrations/001_init.sql). put() is
 * idempotent — ON CONFLICT DO NOTHING keeps the first stored contact for a need.
 */
export class PgContactVault implements ContactVault {
  constructor(
    private readonly pool: pg.Pool,
    private readonly keyHex: string,
  ) {}

  async put(needId: string, plaintext: string): Promise<void> {
    const blob = encryptContact(plaintext, this.keyHex);
    await this.pool.query(
      'INSERT INTO contact_vault (need_id, encrypted_payload) VALUES ($1, $2) ON CONFLICT (need_id) DO NOTHING',
      [needId, blob],
    );
  }

  async get(needId: string): Promise<string | null> {
    const res = await this.pool.query<{ encrypted_payload: Buffer }>(
      'SELECT encrypted_payload FROM contact_vault WHERE need_id = $1',
      [needId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return decryptContact(row.encrypted_payload, this.keyHex);
  }
}

/**
 * Resolve the runtime contact vault from config. Returns undefined (vaulting
 * disabled, with a single boot-time warning) when no key is set — dev without a key
 * must not crash intake; contacts are simply not stored. With a key: Postgres-backed
 * when a pool is available, else the encrypted in-memory vault.
 */
export function createContactVault(opts: { keyHex: string; pool?: pg.Pool | null }): ContactVault | undefined {
  if (opts.keyHex === '') {
    logger.warn(
      'contact vault DISABLED: CONTACT_VAULT_KEY is unset — beneficiary contacts will NOT be stored (dev only). ' +
        'Set a 64-hex-char key to enable AES-256-GCM vaulting.',
    );
    return undefined;
  }
  return opts.pool ? new PgContactVault(opts.pool, opts.keyHex) : new InMemoryContactVault(opts.keyHex);
}

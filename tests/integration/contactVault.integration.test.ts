import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDemoResetStore } from '../../src/demo/reset';
import { createContactVault, PgContactVault } from '../../src/ingest/contactVaultStore';
import type { NeedEvent } from '../../src/ledger/events';
import type { NeedInit } from '../../src/ledger/store/eventStore';
import { PostgresEventStore } from '../../src/ledger/store/postgresStore';
import { migrate } from '../../src/lib/migrate';

// Real-Postgres round-trip for the encrypted contact vault (CLAUDE.md invariant 5).
// The whole block is skipped unless DATABASE_URL is set, so the hermetic suite is
// unaffected. Every row this file writes is is_demo and torn down via the purge path.
const DB = process.env.DATABASE_URL;

// Two distinct 64-hex (256-bit) AES-256-GCM keys. A value decrypts only under the key
// it was written with — reading the same bytea with OTHER_KEY MUST fail, which proves
// the column holds real ciphertext, not an encoded plaintext.
const KEY = 'ab'.repeat(32);
const OTHER_KEY = 'cd'.repeat(32);

describe.skipIf(!DB)('PgContactVault (integration)', () => {
  let pool: pg.Pool;
  let store: PostgresEventStore;

  const needInit = (needId: string): NeedInit => ({
    needId,
    type: 'other',
    severity: 'low',
    localityId: null,
    locationText: null,
    peopleCount: null,
    languages: [],
    sourcePermalink: null,
    confidence: {},
    isDemo: true,
  });

  // A contact_vault row FKs to needs(id), so every test needs a real need first.
  const createDemoNeed = async (): Promise<string> => {
    const needId = randomUUID();
    const s = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const firstEvent: NeedEvent = {
      event_id: `evt_${s}`,
      need_id: needId,
      at: new Date().toISOString(),
      actor: { type: 'system', id: 'intake' },
      idempotency_key: `cv-${s}`,
      type: 'NeedCreated',
      payload: { source: { permalink: `https://s/${s}` }, is_demo: true },
    };
    const res = await store.createNeed(needInit(needId), firstEvent);
    expect(res.created).toBe(true);
    return needId;
  };

  beforeAll(async () => {
    await migrate(DB);
    pool = new pg.Pool({ connectionString: DB });
    store = new PostgresEventStore({ pool });
    await store.init();
  });

  afterAll(async () => {
    if (pool) {
      // Purge mode lets the append-only need_events rows be removed alongside the needs.
      await new PgDemoResetStore({ pool }).purgeDemoRows();
      await pool.end();
    }
  });

  it('round-trips the decrypted contact and stores ciphertext, not plaintext', async () => {
    const needId = await createDemoNeed();
    const vault = new PgContactVault(pool, KEY);
    const contact = '+91 98400 05678';

    await vault.put(needId, contact);
    expect(await vault.get(needId)).toBe(contact);

    const row = await pool.query<{ encrypted_payload: Buffer }>(
      'SELECT encrypted_payload FROM contact_vault WHERE need_id = $1',
      [needId],
    );
    const blob = row.rows[0]?.encrypted_payload;
    expect(blob).toBeInstanceOf(Buffer);
    if (!blob) throw new Error('vault row missing after put');
    // iv(12)+tag(16) prefix ⇒ the blob is longer than the plaintext, and the raw utf8
    // bytes of the number never appear anywhere in the stored blob.
    expect(blob.length).toBeGreaterThan(Buffer.byteLength(contact, 'utf8'));
    expect(blob.includes(Buffer.from(contact, 'utf8'))).toBe(false);

    // Decryption is keyed: the wrong key fails the GCM auth tag → real encryption.
    const wrong = new PgContactVault(pool, OTHER_KEY);
    await expect(wrong.get(needId)).rejects.toThrow();
  });

  it('put is idempotent — ON CONFLICT DO NOTHING keeps the first contact', async () => {
    const needId = await createDemoNeed();
    const vault = new PgContactVault(pool, KEY);
    await vault.put(needId, 'first-9111111111');
    await vault.put(needId, 'second-9222222222');
    expect(await vault.get(needId)).toBe('first-9111111111');
  });

  it('get returns null for a need with no stored contact', async () => {
    const vault = new PgContactVault(pool, KEY);
    expect(await vault.get(randomUUID())).toBeNull();
  });

  it('createContactVault degrades gracefully when no key is set', () => {
    // Missing key ⇒ vaulting disabled (undefined), never a crash on intake.
    expect(createContactVault({ keyHex: '', pool })).toBeUndefined();
    // With a key + pool it builds the Postgres-backed vault.
    expect(createContactVault({ keyHex: KEY, pool })).toBeInstanceOf(PgContactVault);
  });
});

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createContactVault, InMemoryContactVault } from '../../src/ingest/contactVaultStore';

// The PgContactVault path needs a real database and lives in the integration suite;
// here we lock the graceful-degradation factory (the only branch that must run with
// zero env). Crypto + the in-memory vault itself are covered by tests/lib/vault.test.ts.

const KEY = randomBytes(32).toString('hex');

describe('createContactVault — graceful degradation', () => {
  it('returns an in-memory vault when a key is set but no pool is available', async () => {
    const vault = createContactVault({ keyHex: KEY });
    expect(vault).toBeInstanceOf(InMemoryContactVault);
    await vault?.put('need_1', '+91 98400 05678');
    expect(await vault?.get('need_1')).toBe('+91 98400 05678');
  });

  it('disables vaulting (returns undefined) when no key is configured — never crashes intake', () => {
    expect(createContactVault({ keyHex: '' })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import type { Command } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import type { Actor } from '../../src/ledger/types';
import { createRelayTools, type NeedReadPort, type ToolResult } from '../../src/mcp-server/tools';
import { computeSitrepStats } from '../../src/narrate/aggregate';
import { agent, human, isoClock, system } from '../ledger/helpers';

// Unit coverage for the read-only MCP tools (P1). Each handler is exercised by DIRECT CALL
// against an in-memory NeedService — no transport, no SDK server — so the tests are hermetic
// and prove the tool contract itself: correct filtering, PII-free output, evidence +
// verification detail, ledger-matching sitrep numbers, and a clean not-found path.

const NOW = Date.parse('2026-07-06T02:00:00.000Z');

/** Parse a tool result's single text block back into JSON. */
const payload = (r: ToolResult): unknown => JSON.parse(r.content[0]?.text ?? 'null');

/** Every key appearing anywhere in a (possibly nested) JSON value. */
function collectKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      collectKeys(v, out);
    }
  }
  return out;
}

const PII_MARKERS = ['contact', 'phone', 'mobile', 'name', 'address', 'email'];

/** Assert no key anywhere in the payload looks like beneficiary PII. */
function assertNoPii(value: unknown): void {
  for (const key of collectKeys(value)) {
    const lower = key.toLowerCase();
    for (const marker of PII_MARKERS) {
      expect(lower.includes(marker), `PII-looking key leaked: ${key}`).toBe(false);
    }
  }
}

/**
 * Seed a small ledger with needs in varied states:
 *   N-0001 medical/critical → OPEN (awaiting a volunteer)
 *   N-0002 food/high        → VERIFIED (full evidence packet, assigned)
 *   N-0003 water/medium     → TRIAGED
 * Returns a NeedReadPort backed by the same store.
 */
async function seedLedger(): Promise<NeedReadPort> {
  const store = new InMemoryEventStore();
  const svc = new NeedService(store, () => NOW);
  const at = isoClock(NOW - 3_600_000);

  const create = async (key: string): Promise<string> => {
    const r = await svc.createNeed({
      source: { permalink: `https://relay.demo/${key}` },
      actor: system('intake'),
      at: at(),
      idempotencyKey: key,
    });
    if (r.status !== 'created') throw new Error(`seed create failed: ${key}`);
    return r.needId;
  };
  const apply = async (id: string, actor: Actor, command: Command, key: string): Promise<void> => {
    const r = await svc.dispatch(id, command, { actor, at: at(), idempotencyKey: key });
    if (r.status !== 'applied') throw new Error(`seed dispatch failed: ${command.type} (${r.status})`);
  };

  // N-0001 medical/critical → OPEN
  const n1 = await create('need-1');
  await apply(
    n1,
    agent(),
    {
      type: 'ExtractionCompleted',
      payload: { need_type: 'medical', severity: 'critical', location_text: 'Velachery', people_count: 3 },
    },
    'n1-extract',
  );
  await apply(n1, human(), { type: 'TriageConfirmed', payload: {} }, 'n1-triage');

  // N-0002 food/high → VERIFIED with the full L3 evidence packet
  const n2 = await create('need-2');
  await apply(
    n2,
    agent(),
    {
      type: 'ExtractionCompleted',
      payload: { need_type: 'food', severity: 'high', location_text: 'Taramani', people_count: 5 },
    },
    'n2-extract',
  );
  await apply(n2, human(), { type: 'TriageConfirmed', payload: {} }, 'n2-triage');
  await apply(n2, human(), { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1' } }, 'n2-assign');
  await apply(n2, agent(), { type: 'EnRouteReported', payload: { eta_minutes: 5 } }, 'n2-enroute');
  await apply(n2, agent(), { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'E1' } }, 'n2-ev1');
  await apply(
    n2,
    agent(),
    { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', evidence_id: 'E2' } },
    'n2-ev2',
  );
  await apply(n2, human('U_RECIP'), { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } }, 'n2-recip');
  await apply(n2, human(), { type: 'CoordinatorSignedOff', payload: {} }, 'n2-signoff');
  await apply(n2, human(), { type: 'Verified', payload: {} }, 'n2-verify');

  // N-0003 water/medium → TRIAGED (left unconfirmed)
  const n3 = await create('need-3');
  await apply(
    n3,
    agent(),
    {
      type: 'ExtractionCompleted',
      payload: { need_type: 'water', severity: 'medium', location_text: 'Pallikaranai', people_count: 2 },
    },
    'n3-extract',
  );

  return {
    listNeeds: (now) => svc.listNeeds(now),
    getPublicId: (needId) => store.getPublicId(needId),
  };
}

describe('MCP tools — search_needs', () => {
  it('lists all needs as a compact, PII-free summary with exactly the public fields', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });

    const body = payload(await tools.search_needs({})) as {
      count: number;
      total_matched: number;
      needs: Array<Record<string, unknown>>;
    };

    expect(body.count).toBe(3);
    expect(body.total_matched).toBe(3);
    assertNoPii(body);
    const first = body.needs.find((n) => n.public_id === 'N-0001');
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ['is_drifting', 'location_text', 'people_count', 'public_id', 'severity', 'status', 'type'].sort(),
    );
    // Never expose the assigned volunteer or any raw contact channel in the list.
    expect(Object.keys(first ?? {})).not.toContain('assigned_volunteer_id');
  });

  it('filters by type', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ type: 'medical' })) as { needs: Array<{ public_id: string }> };
    expect(body.needs.map((n) => n.public_id)).toEqual(['N-0001']);
  });

  it('filters by severity', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ severity: 'critical' })) as {
      needs: Array<{ public_id: string; severity: string }>;
    };
    expect(body.needs).toHaveLength(1);
    expect(body.needs[0]?.severity).toBe('critical');
  });

  it('filters by status', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ status: 'VERIFIED' })) as { needs: Array<{ public_id: string }> };
    expect(body.needs.map((n) => n.public_id)).toEqual(['N-0002']);
  });

  it('only_open excludes verified/terminal needs and keeps pre-claim ones', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ only_open: true })) as {
      needs: Array<{ public_id: string; status: string }>;
    };
    const ids = body.needs.map((n) => n.public_id).sort();
    expect(ids).toEqual(['N-0001', 'N-0003']); // OPEN + TRIAGED, not the VERIFIED one
  });

  it('filters by locality substring (case-insensitive)', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ locality: 'taram' })) as { needs: Array<{ public_id: string }> };
    expect(body.needs.map((n) => n.public_id)).toEqual(['N-0002']);
  });

  it('respects limit', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({ limit: 2 })) as { count: number; total_matched: number };
    expect(body.count).toBe(2);
    expect(body.total_matched).toBe(3);
  });
});

describe('MCP tools — get_need', () => {
  it('returns the evidence packet + verification summary, PII-free', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });

    const result = await tools.get_need({ public_id: 'N-0002' });
    expect(result.isError).toBeUndefined();
    const detail = payload(result) as {
      public_id: string;
      status: string;
      is_assigned: boolean;
      evidence: Array<{ kind: string; at: string }>;
      verification: { level: number; meets_policy: boolean; missing: string[] };
    };

    assertNoPii(detail);
    expect(detail.public_id).toBe('N-0002');
    expect(detail.status).toBe('VERIFIED');
    expect(detail.is_assigned).toBe(true);
    expect(detail.evidence.map((e) => e.kind)).toEqual([
      'photo',
      'locality_confirm',
      'recipient_confirm',
      'coordinator_signoff',
    ]);
    expect(detail.verification.level).toBe(3);
    expect(detail.verification.meets_policy).toBe(true);
    expect(detail.verification.missing).toEqual([]);
  });

  it('an unknown public_id returns a clean not-found result (never throws)', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });

    const result = await tools.get_need({ public_id: 'N-9999' });
    expect(result.isError).toBe(true);
    const body = payload(result) as { error: string; message: string };
    expect(body.error).toBe('not_found');
    expect(body.message).toContain('N-9999');
  });
});

describe('MCP tools — get_sitrep', () => {
  it('returns ledger-matching numbers computed from the same projection', async () => {
    const service = await seedLedger();
    const tools = createRelayTools({ service, now: () => NOW });

    const stats = payload(await tools.get_sitrep({})) as ReturnType<typeof computeSitrepStats>;
    const expected = computeSitrepStats(await service.listNeeds(NOW), NOW);

    expect(stats).toEqual(expected);
    // Sanity: 3 active needs, 1 verified, 2 in the open bucket (OPEN + TRIAGED).
    expect(stats.totalActive).toBe(3);
    expect(stats.verified).toBe(1);
    expect(stats.open).toBe(2);
    expect(stats.openCritical).toBe(1);
    assertNoPii(stats);
  });

  it('uses an injected sitrep fn when provided', async () => {
    const service = await seedLedger();
    const marker = computeSitrepStats([], NOW);
    const tools = createRelayTools({ service, now: () => NOW, sitrep: () => marker });
    const stats = payload(await tools.get_sitrep({})) as ReturnType<typeof computeSitrepStats>;
    expect(stats.totalActive).toBe(0); // the injected fn won, not the default
  });
});

/** Seed a single OPEN need whose free-text location carries a name + phone, returning the read port. */
async function seedNeedWithLocation(locationText: string): Promise<NeedReadPort> {
  const store = new InMemoryEventStore();
  const svc = new NeedService(store, () => NOW);
  const at = isoClock(NOW - 3_600_000);
  const created = await svc.createNeed({
    source: { permalink: 'https://relay.demo/loc' },
    actor: system('intake'),
    at: at(),
    idempotencyKey: 'loc-1',
  });
  if (created.status !== 'created') throw new Error('seed create failed');
  const id = created.needId;
  const ext = await svc.dispatch(
    id,
    {
      type: 'ExtractionCompleted',
      payload: { need_type: 'rescue', severity: 'critical', location_text: locationText },
    },
    { actor: agent(), at: at(), idempotencyKey: 'loc-extract' },
  );
  if (ext.status !== 'applied') throw new Error('seed extract failed');
  await svc.dispatch(
    id,
    { type: 'TriageConfirmed', payload: {} },
    { actor: human(), at: at(), idempotencyKey: 'loc-triage' },
  );
  return {
    listNeeds: (now) => svc.listNeeds(now),
    getPublicId: (needId) => store.getPublicId(needId),
  };
}

describe('MCP tools — location_text is scrubbed (PII-free by construction, defended)', () => {
  // A coordinator can type anything into the free-text location; the tools must not leak a name
  // or phone through it. Both search_needs and get_need run it through the redaction scrubber.
  const DIRTY = 'Ramesh Kumar house, call 98400 12345, near Velachery';

  it('search_needs redacts a phone/name in location_text', async () => {
    const service = await seedNeedWithLocation(DIRTY);
    const tools = createRelayTools({ service, now: () => NOW });
    const body = payload(await tools.search_needs({})) as { needs: Array<{ location_text: string | null }> };
    const loc = body.needs[0]?.location_text ?? '';
    expect(loc).not.toContain('98400');
    expect(loc).not.toContain('12345');
    expect(loc).not.toContain('Ramesh');
    expect(loc).toContain('[REDACTED:PHONE]');
    expect(loc).toContain('[REDACTED:NAME]');
    expect(loc).toContain('Velachery'); // the gazetteer locality survives — it is not PII
  });

  it('get_need redacts a phone/name in location_text', async () => {
    const service = await seedNeedWithLocation(DIRTY);
    const tools = createRelayTools({ service, now: () => NOW });
    const detail = payload(await tools.get_need({ public_id: 'N-0001' })) as { location_text: string | null };
    const loc = detail.location_text ?? '';
    expect(loc).not.toContain('98400');
    expect(loc).not.toContain('Ramesh');
    expect(loc).toContain('[REDACTED:PHONE]');
  });

  it('the locality filter still matches the RAW text (scrub is output-only)', async () => {
    const service = await seedNeedWithLocation(DIRTY);
    const tools = createRelayTools({ service, now: () => NOW });
    // "Velachery" is in the raw text; the filter finds it even though output is scrubbed.
    const body = payload(await tools.search_needs({ locality: 'velachery' })) as { count: number };
    expect(body.count).toBe(1);
  });
});

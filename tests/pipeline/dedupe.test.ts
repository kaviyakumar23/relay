import { describe, expect, it } from 'vitest';
import type { NeedEvent } from '../../src/ledger/events';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import type { NeedType } from '../../src/ledger/types';
import { contactHash } from '../../src/lib/contactHash';
import { runDedupe } from '../../src/pipeline/dedupe';

// Hermetic dedupe: every need is created + extracted (→ TRIAGED, dedupe-eligible)
// against the in-memory store, then runDedupe auto-detects duplicates and emits
// DuplicateProposed events. No env, no network — the trigram path runs offline.

const BASE = Date.parse('2026-07-06T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

interface SeedOpts {
  key: string;
  atMs: number;
  type: NeedType;
  localityId: number | null;
  contactHash?: string | null;
  dedupeText?: string | null;
  embedding?: number[] | null;
}

interface Seeded {
  needId: string;
  publicId: string;
  createdAtMs: number;
}

async function seed(svc: NeedService, store: InMemoryEventStore, o: SeedOpts): Promise<Seeded> {
  const at = new Date(o.atMs).toISOString();
  const created = await svc.createNeed({
    source: { permalink: `https://s/${o.key}` },
    actor: { type: 'agent', id: 'relay-intake' },
    at,
    idempotencyKey: o.key,
    now: o.atMs,
  });
  if (created.status !== 'created') throw new Error(`seed failed for ${o.key}`);
  // Extraction drives NEW → TRIAGED and stamps type + locality onto the projection.
  const ext = await svc.dispatch(
    created.needId,
    { type: 'ExtractionCompleted', payload: { need_type: o.type, severity: 'high', locality_id: o.localityId } },
    { actor: { type: 'agent', id: 'relay-extract' }, at, idempotencyKey: `${o.key}:x`, now: o.atMs },
  );
  expect(ext.status).toBe('applied');
  await store.setDedupeKeys(created.needId, {
    contactHash: o.contactHash ?? null,
    dedupeText: o.dedupeText ?? null,
    embedding: o.embedding ?? null,
  });
  return { needId: created.needId, publicId: created.publicId, createdAtMs: o.atMs };
}

function makeService(): { svc: NeedService; store: InMemoryEventStore } {
  const store = new InMemoryEventStore();
  return { svc: new NeedService(store), store };
}

const dupProposedFor = (events: NeedEvent[]): NeedEvent[] => events.filter((e) => e.type === 'DuplicateProposed');
const hasDupConfirmed = (events: NeedEvent[]): boolean => events.some((e) => e.type === 'DuplicateConfirmed');

describe('runDedupe — exact contact', () => {
  it('proposes one exact_contact duplicate for two needs from the same number', async () => {
    const { svc, store } = makeService();
    const hash = contactHash('9840005678');
    const older = await seed(svc, store, {
      key: 'a',
      atMs: BASE - HOUR,
      type: 'medical',
      localityId: 1,
      contactHash: hash,
    });
    const fresh = await seed(svc, store, {
      key: 'b',
      atMs: BASE,
      type: 'medical',
      localityId: 1,
      contactHash: hash,
    });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'medical',
      localityId: 1,
      contactHash: hash,
      dedupeText: null,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toEqual([{ otherNeedId: older.needId, score: 1, reason: 'exact_contact' }]);
    const events = await svc.getEvents(fresh.needId);
    const proposed = dupProposedFor(events);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.type === 'DuplicateProposed' && proposed[0].payload).toMatchObject({
      other_need_id: older.needId,
      score: 1,
      reason: 'exact_contact',
    });
    // Merging is a human action — dedupe never confirms.
    expect(hasDupConfirmed(events)).toBe(false);
  });

  it('matches exact contact across localities when the fresh need has no locality', async () => {
    const { svc, store } = makeService();
    const hash = contactHash('9876500011');
    const older = await seed(svc, store, {
      key: 'a',
      atMs: BASE - HOUR,
      type: 'rescue',
      localityId: 7,
      contactHash: hash,
    });
    const fresh = await seed(svc, store, {
      key: 'b',
      atMs: BASE,
      type: 'rescue',
      localityId: null,
      contactHash: hash,
    });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'rescue',
      localityId: null,
      contactHash: hash,
      dedupeText: null,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toEqual([{ otherNeedId: older.needId, score: 1, reason: 'exact_contact' }]);
  });
});

describe('runDedupe — fuzzy same incident', () => {
  it('proposes a similar duplicate for reworded same-type/same-locality text', async () => {
    const { svc, store } = makeService();
    const older = await seed(svc, store, {
      key: 'a',
      atMs: BASE - HOUR,
      type: 'food',
      localityId: 2,
      dedupeText: 'water needed at riverside shelter families stranded',
    });
    const freshText = 'families stranded at riverside shelter need water';
    const fresh = await seed(svc, store, {
      key: 'b',
      atMs: BASE,
      type: 'food',
      localityId: 2,
      dedupeText: freshText,
    });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'food',
      localityId: 2,
      contactHash: null,
      dedupeText: freshText,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.otherNeedId).toBe(older.needId);
    expect(proposals[0]?.reason).toBe('similar');
    expect(proposals[0]?.score).toBeGreaterThanOrEqual(0.5);
    const events = await svc.getEvents(fresh.needId);
    expect(dupProposedFor(events)).toHaveLength(1);
    expect(hasDupConfirmed(events)).toBe(false);
  });
});

describe('runDedupe — near miss (no proposal)', () => {
  it('does not propose across different localities even with identical text', async () => {
    const { svc, store } = makeService();
    const text = 'water needed at riverside shelter families stranded';
    await seed(svc, store, { key: 'a', atMs: BASE - HOUR, type: 'water', localityId: 3, dedupeText: text });
    const fresh = await seed(svc, store, { key: 'b', atMs: BASE, type: 'water', localityId: 4, dedupeText: text });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'water',
      localityId: 4,
      contactHash: null,
      dedupeText: text,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(0);
    expect(dupProposedFor(await svc.getEvents(fresh.needId))).toHaveLength(0);
  });

  it('does not propose when same-locality text similarity is below threshold', async () => {
    const { svc, store } = makeService();
    await seed(svc, store, {
      key: 'a',
      atMs: BASE - HOUR,
      type: 'food',
      localityId: 5,
      dedupeText: 'food supplies running low at the harbour godown',
    });
    const freshText = 'food packets needed at north relief camp';
    const fresh = await seed(svc, store, { key: 'b', atMs: BASE, type: 'food', localityId: 5, dedupeText: freshText });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'food',
      localityId: 5,
      contactHash: null,
      dedupeText: freshText,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(0);
  });

  it('does not propose against candidates outside the 24h window', async () => {
    const { svc, store } = makeService();
    const hash = contactHash('9998887776');
    await seed(svc, store, { key: 'a', atMs: BASE - 48 * HOUR, type: 'medical', localityId: 6, contactHash: hash });
    const fresh = await seed(svc, store, { key: 'b', atMs: BASE, type: 'medical', localityId: 6, contactHash: hash });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'medical',
      localityId: 6,
      contactHash: hash,
      dedupeText: null,
      embedding: null,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(0);
  });
});

describe('runDedupe — embeddings', () => {
  it('proposes similar when both embeddings are present and cosine ≥ 0.86', async () => {
    const { svc, store } = makeService();
    const older = await seed(svc, store, {
      key: 'a',
      atMs: BASE - HOUR,
      type: 'shelter',
      localityId: 8,
      embedding: [1, 0, 0],
    });
    const freshEmbed = [0.95, 0.31, 0];
    const fresh = await seed(svc, store, {
      key: 'b',
      atMs: BASE,
      type: 'shelter',
      localityId: 8,
      embedding: freshEmbed,
    });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'shelter',
      localityId: 8,
      contactHash: null,
      dedupeText: null,
      embedding: freshEmbed,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.otherNeedId).toBe(older.needId);
    expect(proposals[0]?.reason).toBe('similar');
    expect(proposals[0]?.score).toBeGreaterThanOrEqual(0.86);
  });

  it('does not propose when embedding cosine is below threshold', async () => {
    const { svc, store } = makeService();
    await seed(svc, store, { key: 'a', atMs: BASE - HOUR, type: 'shelter', localityId: 9, embedding: [1, 0, 0] });
    const freshEmbed = [0, 1, 0];
    const fresh = await seed(svc, store, {
      key: 'b',
      atMs: BASE,
      type: 'shelter',
      localityId: 9,
      embedding: freshEmbed,
    });

    const { proposals } = await runDedupe({
      needId: fresh.needId,
      publicId: fresh.publicId,
      type: 'shelter',
      localityId: 9,
      contactHash: null,
      dedupeText: null,
      embedding: freshEmbed,
      createdAtMs: fresh.createdAtMs,
      store,
      service: svc,
      now: BASE,
    });

    expect(proposals).toHaveLength(0);
  });
});

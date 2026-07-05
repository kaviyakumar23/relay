import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { needCreatedKey } from '../../src/ledger/idempotency';

// Walking-skeleton e2e (BUILD-DOC §16.2). Drives synthetic intake events through
// the SAME hermetic assembly the demo + live app use, and asserts the full Day-1
// round-trip plus BOTH idempotency layers:
//   1. transport dedupe (slack_events / DedupeStore) — same envelope event id
//   2. business idempotency (needCreatedKey) — same channel/ts, fresh event id

const EVENTS = [
  {
    eventId: 'Ev01',
    messageTs: '1720051200.000111',
    userId: 'U_REPORTER1',
    text: 'Terrace flooded in Velachery, food needed',
  },
  {
    eventId: 'Ev02',
    messageTs: '1720051201.000222',
    userId: 'U_REPORTER2',
    text: 'Dialysis patient stuck near Taramani',
  },
  {
    eventId: 'Ev03',
    messageTs: '1720051202.000333',
    userId: 'U_REPORTER3',
    text: 'Family trapped on first floor in Pallikaranai',
  },
];

describe('skeleton e2e — intake message → NeedCreated + dispatch card', () => {
  it('creates one need + one dispatch card per intake event', async () => {
    const a = buildHermeticAssembly();

    for (const e of EVENTS) {
      expect(await injectIntake(a, e)).toBe('enqueued');
    }

    const needs = await a.service.listNeeds();
    expect(needs).toHaveLength(3);
    expect(a.notifier.cards).toHaveLength(3);

    // Public ids are monotonic N-000x.
    expect(a.notifier.publicIds()).toEqual(['N-0001', 'N-0002', 'N-0003']);

    // Extraction now runs in the intake job: each of these three messages classifies
    // to a known type + locality (none garbled), so every need advances NEW → TRIAGED
    // and its row cache agrees. (Day-1 asserted NEW here; the ExtractionCompleted event
    // is why that changed.)
    for (const n of needs) {
      expect(n.state).toBe('TRIAGED');
      expect(a.store.getRow(n.need_id)?.status).toBe('TRIAGED');
    }

    // The first event of each need is still NeedCreated carrying the deterministic key
    // (extraction appends a second ExtractionCompleted event after it).
    for (let i = 0; i < EVENTS.length; i++) {
      const card = a.notifier.cards[i];
      const ev = EVENTS[i];
      if (!card || !ev) throw new Error('missing card/event');
      expect(card.projection.state).toBe('TRIAGED');
      const log = await a.store.getEvents(card.needId);
      const first = log[0];
      if (!first) throw new Error('empty event log');
      expect(first.type).toBe('NeedCreated');
      expect(log[1]?.type).toBe('ExtractionCompleted');
      expect(first.idempotency_key).toBe(needCreatedKey(a.teamId, a.intakeChannelId, ev.messageTs));
    }
  });

  it('layer 1 — a redelivery with the same envelope id is dropped (transport dedupe)', async () => {
    const a = buildHermeticAssembly();
    for (const e of EVENTS) await injectIntake(a, e);

    for (const e of EVENTS) {
      expect(await injectIntake(a, e)).toBe('skipped_duplicate');
    }

    expect(await a.service.listNeeds()).toHaveLength(3);
    expect(a.notifier.cards).toHaveLength(3);
  });

  it('layer 2 — a fresh envelope id for the same channel/ts creates no new need (business idempotency)', async () => {
    const a = buildHermeticAssembly();
    for (const e of EVENTS) await injectIntake(a, e);

    for (const e of EVENTS) {
      // Transport layer lets it through (new event id) ...
      const outcome = await injectIntake(a, { ...e, eventId: `${e.eventId}:retry` });
      expect(outcome).toBe('enqueued');
    }
    // ... but needCreatedKey collapses it: no second row, no second card.
    expect(await a.service.listNeeds()).toHaveLength(3);
    expect(a.notifier.cards).toHaveLength(3);
    expect(a.notifier.publicIds()).toEqual(['N-0001', 'N-0002', 'N-0003']);
  });
});

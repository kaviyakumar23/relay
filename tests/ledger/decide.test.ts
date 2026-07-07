import { describe, expect, it } from 'vitest';
import { type DecideContext, decide } from '../../src/ledger/decide';
import type { Command, NeedEvent } from '../../src/ledger/events';
import { GuardViolation } from '../../src/ledger/store/errors';
import { agent, ev, human, isoClock } from './helpers';

const NEED = 'need-1';

/** Build a raw event log up to OPEN (NeedCreated → ExtractionCompleted → TriageConfirmed). */
function openLog(): NeedEvent[] {
  const at = isoClock();
  return [
    ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: { permalink: 'https://s/1' } } }, 'k-create'),
    ev(
      NEED,
      at(),
      agent(),
      { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
      'k-extract',
    ),
    ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }, 'k-triage'),
  ];
}

function ctx(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    needId: NEED,
    actor: human(),
    at: '2026-07-04T01:00:00.000Z',
    idempotencyKey: `k-${Math.random()}`,
    now: Date.parse('2026-07-04T01:00:00.000Z'),
    ...overrides,
  };
}

describe('decide — illegal transitions', () => {
  it('rejects an out-of-order transition even for a human actor', () => {
    const log = [openLog()[0]] as NeedEvent[]; // state NEW
    const d = decide(log, { type: 'TriageConfirmed', payload: {} }, ctx());
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('ILLEGAL_TRANSITION');
  });

  it('rejects a lifecycle command against a non-existent need', () => {
    const d = decide([], { type: 'Assigned', payload: { volunteer_id: 'V1' } }, ctx());
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('decide — ExtractionCompleted human field-correction override', () => {
  /** NeedCreated → Extraction → Triage → Assigned (human): a CLAIMED need. */
  function claimedLog(): NeedEvent[] {
    const at = isoClock();
    return [
      ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: {} } }, 'k-create'),
      ev(
        NEED,
        at(),
        agent(),
        { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
        'k-extract',
      ),
      ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }, 'k-triage'),
      ev(NEED, at(), human(), { type: 'Assigned', payload: { volunteer_id: 'V1' } }, 'k-assign'),
    ];
  }

  it('admits a human ExtractionCompleted from a committed (CLAIMED) need — the card Edit override', () => {
    const d = decide(
      claimedLog(),
      { type: 'ExtractionCompleted', payload: { need_type: 'rescue', severity: 'high', people_count: 4 } },
      ctx({ actor: human() }),
    );
    expect(d.outcome).toBe('emit');
  });
});

describe('decide — human gates (§6.2)', () => {
  it('rejects Assigned proposed by an agent actor', () => {
    const d = decide(openLog(), { type: 'Assigned', payload: { volunteer_id: 'V1' } }, ctx({ actor: agent() }));
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('HUMAN_GATE');
  });

  it('rejects Cancelled proposed by a system actor', () => {
    const d = decide(
      openLog(),
      { type: 'Cancelled', payload: { reason: 'obsolete' } },
      ctx({ actor: { type: 'system', id: 'sweeper' } }),
    );
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('HUMAN_GATE');
  });

  it('emits when the same gated command carries a human actor', () => {
    const d = decide(
      openLog(),
      { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1' } },
      ctx({ actor: human() }),
    );
    expect(d.outcome).toBe('emit');
    if (d.outcome === 'emit') {
      expect(d.events).toHaveLength(1);
      expect(d.events[0]?.type).toBe('Assigned');
      expect(d.events[0]?.actor.type).toBe('human');
    }
  });

  it('allows a non-gated command from an agent actor (ExtractionCompleted)', () => {
    const log = [openLog()[0]] as NeedEvent[]; // NEW
    const d = decide(
      log,
      { type: 'ExtractionCompleted', payload: { need_type: 'food', severity: 'low' } },
      ctx({ actor: agent() }),
    );
    expect(d.outcome).toBe('emit');
  });
});

describe('decide — idempotency & validation', () => {
  it('suppresses a command whose idempotency key is already in the log', () => {
    const d = decide(
      openLog(),
      { type: 'MatchSuggested', payload: { candidates: [] } },
      ctx({ idempotencyKey: 'k-triage' }),
    );
    expect(d.outcome).toBe('suppressed');
  });

  it('rejects an invalid command payload at the boundary', () => {
    const bad = { type: 'Assigned', payload: {} } as unknown as Command;
    const d = decide(openLog(), bad, ctx());
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('INVALID_PAYLOAD');
  });

  it('rejects a blank envelope (missing actor id)', () => {
    const d = decide(
      openLog(),
      { type: 'MatchSuggested', payload: { candidates: [] } },
      ctx({ actor: { type: 'agent', id: '' } }),
    );
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('INVALID_ENVELOPE');
  });

  it('throws a zero-copy GuardViolation when a persisted field carries raw content', () => {
    const raw = 'x'.repeat(1001);
    expect(() => decide(openLog(), { type: 'TriageConfirmed', payload: { note: raw } }, ctx())).toThrow(GuardViolation);
  });
});

describe('decide — evidence policy', () => {
  it('rejects Verified before the severity evidence policy is met (critical needs L3)', () => {
    const at = isoClock();
    const log: NeedEvent[] = [
      ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: {} } }, 'c1'),
      ev(
        NEED,
        at(),
        agent(),
        { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } },
        'c2',
      ),
      ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }, 'c3'),
      ev(NEED, at(), human(), { type: 'Assigned', payload: { volunteer_id: 'V1' } }, 'c4'),
      ev(NEED, at(), agent(), { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'E1' } }, 'c5'),
    ];
    const d = decide(log, { type: 'Verified', payload: {} }, ctx());
    expect(d.outcome).toBe('rejected');
    if (d.outcome === 'rejected') expect(d.code).toBe('INSUFFICIENT_EVIDENCE');
  });
});

import { describe, expect, it } from 'vitest';
import type { NeedEvent } from '../../src/ledger/events';
import { project, projectAt } from '../../src/ledger/projection';
import { agent, ev, human, isoClock, system } from './helpers';

const NEED = 'need-1';

function lifecycleEvents(): NeedEvent[] {
  const at = isoClock();
  return [
    ev(NEED, at(), agent(), {
      type: 'NeedCreated',
      payload: { source: { permalink: 'https://s/1', channel: 'C1', ts: '1.0' } },
    }),
    ev(NEED, at(), agent(), {
      type: 'ExtractionCompleted',
      payload: {
        need_type: 'medical',
        severity: 'critical',
        locality_id: 7,
        people_count: 3,
        languages: ['ta', 'en'],
        confidence: { type: 'stated', severity: 'inferred' },
        needs_review: false,
      },
    }),
    ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }),
    ev(NEED, at(), agent(), { type: 'MatchSuggested', payload: { candidates: [{ volunteer_id: 'V1', score: 0.9 }] } }),
    ev(NEED, at(), human(), { type: 'Assigned', payload: { volunteer_id: 'V1', obligation_id: 'OB1' } }),
    ev(NEED, at(), agent(), { type: 'EnRouteReported', payload: { eta_minutes: 10 } }),
    ev(NEED, at(), agent(), { type: 'EvidenceAttached', payload: { kind: 'photo', evidence_id: 'E1' } }),
    ev(NEED, at(), agent(), { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', evidence_id: 'E2' } }),
    ev(NEED, at(), human('U_RECIP'), { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } }),
    ev(NEED, at(), human(), { type: 'CoordinatorSignedOff', payload: {} }),
    ev(NEED, at(), human(), { type: 'Verified', payload: {} }),
    ev(NEED, at(), human(), { type: 'Closed', payload: {} }),
  ];
}

describe('projection — happy path fold', () => {
  it('derives triaged-then-open state and carries extraction-derived fields', () => {
    const at = isoClock();
    const events: NeedEvent[] = [
      ev(NEED, at(), system('intake'), {
        type: 'NeedCreated',
        payload: { source: { permalink: 'https://s/1', channel: 'C1', ts: '1.0' }, is_demo: true },
      }),
      ev(NEED, at(), agent(), {
        type: 'ExtractionCompleted',
        payload: {
          need_type: 'food',
          severity: 'high',
          locality_id: 4,
          people_count: 3,
          languages: ['ta'],
          confidence: { locality: 'stated' },
        },
      }),
      ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }),
    ];
    const need = project(events);
    expect(need.state).toBe('OPEN');
    expect(need.type).toBe('food');
    expect(need.severity).toBe('high');
    expect(need.locality_id).toBe(4);
    expect(need.people_count).toBe(3);
    expect(need.languages).toEqual(['ta']);
    expect(need.confidence).toEqual({ locality: 'stated' });
    expect(need.source.permalink).toBe('https://s/1');
    expect(need.flags.is_open).toBe(true);
    expect(need.flags.is_active).toBe(true);
    expect(need.history_count).toBe(3);
    expect(need.state_version).toBe(3);
  });
});

describe('projection — full lifecycle to CLOSED', () => {
  it('folds the entire main path and accumulates the evidence packet', () => {
    const need = project(lifecycleEvents());
    expect(need.state).toBe('CLOSED');
    expect(need.assigned_volunteer_id).toBe('V1');
    expect(need.obligation_id).toBe('OB1');
    expect(need.evidence.map((e) => e.kind)).toEqual([
      'photo',
      'locality_confirm',
      'recipient_confirm',
      'coordinator_signoff',
    ]);
    expect(need.flags.is_active).toBe(false);
  });

  it('projectAt replays point-in-time state (OPEN at TriageConfirmed)', () => {
    const events = lifecycleEvents();
    const triage = events[2];
    if (!triage) throw new Error('fixture missing TriageConfirmed');
    const at = projectAt(events, triage.event_id);
    expect(at.state).toBe('OPEN');
    expect(at.evidence).toHaveLength(0);
  });
});

describe('projection — invariants', () => {
  it('severity floor only ever raises (a later lower extraction cannot lower it)', () => {
    const at = isoClock();
    const events: NeedEvent[] = [
      ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: {} } }),
      ev(NEED, at(), agent(), { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'critical' } }),
      ev(NEED, at(), agent(), { type: 'ExtractionCompleted', payload: { need_type: 'medical', severity: 'low' } }),
    ];
    expect(project(events).severity).toBe('critical');
  });

  it('a later ExtractionCompleted (human Edit override) refines fields but does NOT rewind the lifecycle', () => {
    const at = isoClock();
    const events: NeedEvent[] = [
      ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: {} } }),
      ev(NEED, at(), agent(), {
        type: 'ExtractionCompleted',
        payload: { need_type: 'water', severity: 'high', people_count: 2 },
      }),
      ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }),
      ev(NEED, at(), human(), { type: 'Assigned', payload: { volunteer_id: 'V1' } }),
      // The coordinator corrects the extracted fields on the CLAIMED card (a human override).
      ev(NEED, at(), human(), {
        type: 'ExtractionCompleted',
        payload: { need_type: 'rescue', severity: 'low', people_count: 5, location_text: 'north jetty' },
      }),
    ];
    const need = project(events);
    // State is NOT rewound to TRIAGED — the correction keeps the current (CLAIMED) state.
    expect(need.state).toBe('CLAIMED');
    // The refined fields are applied…
    expect(need.type).toBe('rescue');
    expect(need.people_count).toBe(5);
    expect(need.location_text).toBe('north jetty');
    // …but the severity floor only ever raises: the 'low' correction cannot lower 'high'.
    expect(need.severity).toBe('high');
  });

  it('computes is_drifting as a flag (not a state) when past sla_due_at', () => {
    const at = isoClock();
    const claimAt = Date.parse('2026-07-04T00:00:03.000Z');
    const events: NeedEvent[] = [
      ev(NEED, at(), agent(), { type: 'NeedCreated', payload: { source: {} } }),
      ev(NEED, at(), agent(), { type: 'ExtractionCompleted', payload: { need_type: 'food', severity: 'high' } }),
      ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} }),
      ev(NEED, new Date(claimAt).toISOString(), human(), {
        type: 'Assigned',
        payload: { volunteer_id: 'V1', sla_due_at: '2026-07-04T00:05:00.000Z' },
      }),
    ];
    const drifting = project(events, { now: Date.parse('2026-07-04T00:10:00.000Z') });
    expect(drifting.state).toBe('CLAIMED');
    expect(drifting.flags.is_drifting).toBe(true);
    const onTime = project(events, { now: Date.parse('2026-07-04T00:01:00.000Z') });
    expect(onTime.flags.is_drifting).toBe(false);
  });

  it('throws on empty log or a log that does not begin with NeedCreated', () => {
    expect(() => project([])).toThrow(/empty/);
    const at = isoClock();
    expect(() => project([ev(NEED, at(), human(), { type: 'TriageConfirmed', payload: {} })])).toThrow(
      /must begin with NeedCreated/,
    );
  });
});

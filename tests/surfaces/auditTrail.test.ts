import { describe, expect, it } from 'vitest';
import type { NeedEvent } from '../../src/ledger/events';
import type { Actor } from '../../src/ledger/types';
import {
  type AuditStats,
  auditButtonElement,
  buildAuditTrail,
  buildReportAuditPanel,
  decodeFigureAudit,
  encodeFigureAudit,
  REPORT_AUDIT_ACTION,
} from '../../src/surfaces/auditTrail';
import type { SlackBlock } from '../../src/surfaces/primitives';

// Click-to-audit (Moonshot #6). The audit trail is READ-ONLY over the ledger and REDACTED: it shows
// event type / evidence kind / time / actor ROLE only — never an actor id, evidence file reference,
// or free-text note. The figure-audit codec round-trips a figure key + its backing need_ids.

let seq = 0;
function ev(type: NeedEvent['type'], actor: Actor, payload: Record<string, unknown> = {}): NeedEvent {
  seq += 1;
  return {
    event_id: `e${seq}`,
    need_id: 'need-1',
    at: '2026-07-04T00:00:19.000Z',
    actor,
    idempotency_key: `k${seq}`,
    type,
    payload,
  } as unknown as NeedEvent;
}

const SYSTEM: Actor = { type: 'system', id: 'relay-pipeline' };
const AGENT: Actor = { type: 'agent', id: 'relay-evidence' };
const HUMAN: Actor = { type: 'human', id: 'U_COORD_SECRET_ID' };

// A full lifecycle with things that MUST be redacted: an actor id, an evidence file reference, and a
// free-text note.
const LIFECYCLE: NeedEvent[] = [
  ev('NeedCreated', SYSTEM, { source: { permalink: 'https://relay.demo/x' } }),
  ev('ExtractionCompleted', AGENT, { need_type: 'food', severity: 'high' }),
  ev('TriageConfirmed', HUMAN, { note: 'SECRET_NOTE_TEXT' }),
  ev('EvidenceAttached', AGENT, { kind: 'photo', evidence_id: 'F_SECRET_FILE_REF' }),
  ev('RecipientConfirmed', AGENT, { confirmed_by: 'recipient' }),
  ev('CoordinatorSignedOff', HUMAN, {}),
  ev('Verified', HUMAN, {}),
  ev('Closed', HUMAN, {}),
];

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

describe('encode/decodeFigureAudit', () => {
  it('round-trips a figure key and its backing need_ids', () => {
    const value = encodeFigureAudit('total_needs', ['id-1', 'id-2']);
    expect(value).toBe('total_needs~id-1,id-2');
    expect(decodeFigureAudit(value)).toEqual({ figureKey: 'total_needs', needIds: ['id-1', 'id-2'] });
  });

  it('decodes a value with no ids to an empty list', () => {
    expect(decodeFigureAudit('verified_deliveries~')).toEqual({ figureKey: 'verified_deliveries', needIds: [] });
    expect(decodeFigureAudit('malformed')).toEqual({ figureKey: 'malformed', needIds: [] });
  });

  it('caps the encoded id list so the button value stays bounded', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `id-${i}`);
    const { needIds } = decodeFigureAudit(encodeFigureAudit('k', ids));
    expect(needIds.length).toBe(24);
  });
});

describe('auditButtonElement / buildReportAuditPanel', () => {
  it('builds a button whose action_id routes to report_audit and value encodes the ids', () => {
    const btn = auditButtonElement('verified_deliveries', ['id-1'], 'verified deliveries') as {
      action_id: string;
      value: string;
    };
    expect(btn.action_id.startsWith(`${REPORT_AUDIT_ACTION}:`)).toBe(true);
    expect(decodeFigureAudit(btn.value)).toEqual({ figureKey: 'verified_deliveries', needIds: ['id-1'] });
  });

  it('renders an audit button only for figures that have backing need_ids', () => {
    const stats: AuditStats = {
      stats: [
        { key: 'total_needs', label: 'needs verified', value: 2, eventRefs: ['a', 'b'] },
        { key: 'people_helped', label: 'people helped', value: 9, eventRefs: [] }, // no refs → no button
      ],
    };
    const panel = buildReportAuditPanel(stats);
    const dump = jsonOf(panel);
    expect(dump).toContain('report_audit:total_needs');
    expect(dump).not.toContain('report_audit:people_helped');
  });

  it('respects a figureKeys allow-list and is empty when nothing has refs', () => {
    const stats: AuditStats = {
      stats: [
        { key: 'total_needs', label: 'needs', value: 1, eventRefs: ['a'] },
        { key: 'verified_deliveries', label: 'verified', value: 1, eventRefs: ['a'] },
      ],
    };
    const dump = jsonOf(buildReportAuditPanel(stats, { figureKeys: ['total_needs'] }));
    expect(dump).toContain('report_audit:total_needs');
    expect(dump).not.toContain('report_audit:verified_deliveries');
    expect(buildReportAuditPanel({ stats: [{ key: 'x', label: 'x', value: 0 }] })).toEqual([]);
  });
});

describe('buildAuditTrail — redacted evidence chain', () => {
  it('shows the lifecycle labels, the evidence kind, and the public id', () => {
    const dump = jsonOf(buildAuditTrail('N-0002', LIFECYCLE));
    expect(dump).toContain('N-0002');
    expect(dump).toContain('Need created');
    expect(dump).toContain('Verified on evidence');
    expect(dump).toContain('Closed');
    expect(dump).toContain('Coordinator signed off');
    expect(dump).toContain('photo'); // the (allowed) evidence kind
  });

  it('shows actor ROLES only, never an actor id', () => {
    const dump = jsonOf(buildAuditTrail('N-0002', LIFECYCLE));
    expect(dump).toContain('a human actor');
    expect(dump).toContain('an automated agent');
    expect(dump).toContain('the system');
    expect(dump).not.toContain('U_COORD_SECRET_ID');
  });

  it('never leaks an evidence file reference or a free-text note', () => {
    const dump = jsonOf(buildAuditTrail('N-0002', LIFECYCLE));
    expect(dump).not.toContain('F_SECRET_FILE_REF');
    expect(dump).not.toContain('SECRET_NOTE_TEXT');
  });

  it('renders the engine-derived verification badge', () => {
    const closedDump = jsonOf(buildAuditTrail('N-0002', LIFECYCLE));
    expect(closedDump).toContain('Verified on evidence · closed');
    const openDump = jsonOf(buildAuditTrail('N-0003', [LIFECYCLE[0] as NeedEvent]));
    expect(openDump).toContain('not yet verified');
  });

  it('honours the limit option (fewer lifecycle rows, badge still reflects the full log)', () => {
    const dump = jsonOf(buildAuditTrail('N-0002', LIFECYCLE, { limit: 1 }));
    expect(dump).toContain('Need created');
    // A later row label (only rendered as a row, never in the badge) is dropped by the limit.
    expect(dump).not.toContain('Coordinator signed off');
    // The engine-derived badge is computed over ALL events, so it still shows verified · closed.
    expect(dump).toContain('Verified on evidence · closed');
  });
});

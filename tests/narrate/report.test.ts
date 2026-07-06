import { describe, expect, it } from 'vitest';
import type { NeedEvent } from '../../src/ledger/events';
import type { ProjectedNeed } from '../../src/ledger/types';
import { MockLlm } from '../../src/llm/mock';
import { assertNoPii } from '../../src/narrate/redaction';
import { generateReport, parseReportPeriod, type ReportService } from '../../src/narrate/report';

// Unit coverage for the verified-impact report generator (F7): verified-only figures, the F7
// PII hard-gate (a PII-carrying narrative can NEVER be emitted), and Markdown structure.

const T0 = Date.parse('2026-07-04T00:00:00.000Z');
const T_VERIFIED = T0 + 30 * 60_000; // 30-minute response
const NOW = T_VERIFIED + 60_000;

const need = {
  need_id: 'abcd1234-ef56-7890',
  state: 'VERIFIED',
  type: 'food',
  severity: 'high',
  people_count: 12,
  assigned_volunteer_id: 'SEED_U03',
  evidence: [
    { kind: 'photo', at: new Date(T0 + 1_000).toISOString() },
    { kind: 'recipient_confirm', at: new Date(T0 + 2_000).toISOString() },
    { kind: 'coordinator_signoff', at: new Date(T_VERIFIED - 1_000).toISOString() },
  ],
  location_text: 'Velachery',
  locality_id: 1,
  languages: ['en'],
  source: { permalink: 'https://relay.demo/C1/p1720051200000111' },
  confidence: {},
  merged_into: null,
  obligation_id: null,
  sla_due_at: null,
  flags: {
    is_active: false,
    is_open: false,
    is_drifting: false,
    is_at_risk: false,
    is_unverified: false,
    needs_review: false,
    is_duplicate: false,
  },
  state_version: 1,
  history_count: 6,
  created_at: new Date(T0).toISOString(),
  updated_at: new Date(T_VERIFIED).toISOString(),
} as unknown as ProjectedNeed;

const verifiedEvent = {
  event_id: 'e1',
  need_id: need.need_id,
  at: new Date(T_VERIFIED).toISOString(),
  actor: { type: 'human', id: 'demo-coordinator' },
  idempotency_key: 'k1',
  type: 'Verified',
  payload: {},
} as unknown as NeedEvent;

const service: ReportService = {
  listNeeds: async () => [need],
  getEvents: async () => [verifiedEvent],
};

describe('generateReport — F7 verified-impact report', () => {
  it('no llm ⇒ template narrative; Markdown carries the verified figures + source-linked footnotes', async () => {
    const report = await generateReport({ service, period: { label: 'all time' }, now: NOW });

    expect(report.source).toBe('template');
    expect(report.stats.totalNeeds).toBe(1);
    expect(report.stats.peopleHelped).toBe(12);
    expect(report.stats.medianResponseMinutes).toBe(30);
    expect(report.stats.evidenceCompletePct).toBe(100);

    expect(report.markdown).toContain('# Relay verified-impact report');
    expect(report.markdown).toContain('## Verified figures');
    expect(report.markdown).toContain('## Footnotes');
    expect(report.markdown).toContain('12'); // people helped
    // A letter-prefixed public-id ref (default resolver) — never a raw digit-led token.
    expect(report.markdown).toContain('N-abcd1234');
    expect(assertNoPii(report.markdown).ok).toBe(true);
  });

  it('F7 HARD gate — a narrative carrying PII can NEVER be emitted (hard-falls back to template)', async () => {
    // The email is digit-free, so it passes the number guard — only the PII gate stops it.
    const llm = new MockLlm(() => ({
      narrative: 'We reached {{stat:people_helped}} people; write to relay-ops@example.org for details.',
    }));
    const report = await generateReport({ service, llm, period: { label: 'all time' }, now: NOW });

    expect(report.source).toBe('template');
    expect(report.markdown).not.toContain('relay-ops@example.org');
    expect(report.markdown).not.toContain('@');
    expect(assertNoPii(report.markdown).ok).toBe(true);
  });

  it('parseReportPeriod maps the argument to a labelled window', () => {
    const now = Date.parse('2026-07-04T12:00:00.000Z');
    expect(parseReportPeriod('24h', now)).toEqual({ label: 'last 24 hours', sinceMs: now - 86_400_000 });
    expect(parseReportPeriod('7d', now)).toEqual({ label: 'last 7 days', sinceMs: now - 7 * 86_400_000 });
    expect(parseReportPeriod('', now)).toEqual({ label: 'all time' });
    expect(parseReportPeriod('nonsense', now)).toEqual({ label: 'all time' });
  });
});

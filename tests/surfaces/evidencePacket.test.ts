import { describe, expect, it } from 'vitest';
import type { EvidenceKind, ProjectedNeed, Severity } from '../../src/ledger/types';
import { emptyFlags } from '../../src/ledger/types';
import { buildEvidencePacket } from '../../src/surfaces/evidencePacket';
import type { SlackBlock } from '../../src/surfaces/primitives';

// The evidence trail rendering (BUILD-DOC §F5): one line per EvidenceRef + a verification
// badge. Pure over the projection; renders references/kinds/times only (zero-copy, #5).

function needWith(severity: Severity, kinds: EvidenceKind[]): ProjectedNeed {
  return {
    need_id: 'need_1',
    state: 'DELIVERED_UNVERIFIED',
    type: 'water',
    severity,
    locality_id: null,
    location_text: null,
    people_count: null,
    languages: [],
    source: {},
    confidence: {},
    merged_into: null,
    assigned_volunteer_id: 'V1',
    obligation_id: null,
    sla_due_at: null,
    evidence: kinds.map((kind, i) => ({ kind, at: `2026-07-06T10:0${i}:00.000Z` })),
    flags: emptyFlags(),
    state_version: 1,
    history_count: 1,
    created_at: '2026-07-06T09:00:00.000Z',
    updated_at: '2026-07-06T10:00:00.000Z',
  };
}

const dump = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

/** Context lines that carry an evidence icon (excludes the heading + badge). */
function evidenceLines(blocks: SlackBlock[]): string[] {
  return blocks
    .filter((b) => (b as { type?: string }).type === 'context')
    .map((b) => (b as { elements: Array<{ text: string }> }).elements[0]?.text ?? '')
    .filter((t) => /📷|📍|🙋|✅/.test(t));
}

describe('buildEvidencePacket', () => {
  it('renders one line per evidence item with the right icon and a UTC time', () => {
    const blocks = buildEvidencePacket(needWith('medium', ['photo', 'recipient_confirm']));
    const lines = evidenceLines(blocks);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('📷');
    expect(lines[0]).toContain('2026-07-06 10:00:00 UTC');
    expect(lines[1]).toContain('🙋');
  });

  it('shows a met-policy badge when the packet satisfies the severity policy', () => {
    const blocks = buildEvidencePacket(needWith('medium', ['recipient_confirm']));
    const text = dump(blocks);
    expect(text).toContain('Verification: L2 ✓');
    expect(text).toContain('meets L2 policy');
  });

  it('shows the required level and missing kinds when short of policy', () => {
    const blocks = buildEvidencePacket(needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm']));
    const text = dump(blocks);
    expect(text).toContain('L3 required');
    expect(text).toContain('missing: coordinator sign-off');
  });

  it('renders a full L3 badge for a complete critical packet', () => {
    const blocks = buildEvidencePacket(
      needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
    );
    expect(evidenceLines(blocks)).toHaveLength(4);
    expect(dump(blocks)).toContain('Verification: L3 ✓');
  });

  it('renders a "cannot be verified" note for an empty packet', () => {
    const blocks = buildEvidencePacket(needWith('low', []));
    expect(evidenceLines(blocks)).toHaveLength(0);
    expect(dump(blocks)).toContain('cannot be verified');
  });

  it('never leaks any text beyond references, kinds, times, and the badge (zero-copy)', () => {
    const need = needWith('high', ['photo', 'locality_confirm']);
    const first = need.evidence[0];
    if (first) first.evidence_id = 'F0FILEID';
    const text = dump(buildEvidencePacket(need));
    expect(text).toContain('F0FILEID'); // a Slack file reference is allowed
    expect(text).not.toContain('null');
  });

  it('ticks present evidence ✓ and shows required-but-missing evidence as ○ pending', () => {
    const blocks = buildEvidencePacket(needWith('critical', ['photo', 'locality_confirm']));
    const lines = evidenceLines(blocks);
    // photo + location ticked; recipient + sign-off still required → pending.
    expect(lines.find((l) => l.includes('📷'))).toContain('✓');
    expect(lines.find((l) => l.includes('📍'))).toContain('✓');
    expect(lines.find((l) => l.includes('🙋'))).toContain('pending');
    expect(lines.find((l) => l.includes('✅'))).toContain('pending');
  });

  it('renders the verification badge as a prominent section, not a small context line', () => {
    const blocks = buildEvidencePacket(needWith('medium', ['recipient_confirm']));
    const badge = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'section' &&
        ((b as { text?: { text?: string } }).text?.text ?? '').includes('Verification:'),
    ) as { text?: { text?: string } } | undefined;
    expect(badge).toBeDefined();
    expect(badge?.text?.text).toContain('✅'); // met policy → an accomplishment badge
  });

  it('renders a fully-proven critical packet as four ✓ checklist ticks', () => {
    const lines = evidenceLines(
      buildEvidencePacket(
        needWith('critical', ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
      ),
    );
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.includes('✓'))).toBe(true);
  });
});

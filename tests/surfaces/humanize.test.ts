import { describe, expect, it } from 'vitest';
import type { NeedState } from '../../src/ledger/types';
import { humanizeState } from '../../src/surfaces/humanize';

// humanizeState is display-only copy for the need lifecycle. It must Title-case, drop the
// underscores, and never leak a SHOUTING_ENUM to a human-facing surface — while the raw enum
// stays the source of truth in the ledger/logs (asserted implicitly by this being pure copy).

describe('humanizeState', () => {
  it('turns the enum into calm, human copy', () => {
    expect(humanizeState('NEEDS_REVIEW')).toBe('Needs review');
    expect(humanizeState('MATCH_SUGGESTED')).toBe('Match suggested');
    expect(humanizeState('IN_PROGRESS')).toBe('In progress');
    expect(humanizeState('DELIVERED_UNVERIFIED')).toBe('Delivered · unverified');
    expect(humanizeState('OPEN')).toBe('Open');
    expect(humanizeState('VERIFIED')).toBe('Verified');
  });

  it('never renders an underscore or an all-caps run for any state', () => {
    const states: NeedState[] = [
      'NEW',
      'TRIAGED',
      'OPEN',
      'MATCH_SUGGESTED',
      'CLAIMED',
      'IN_PROGRESS',
      'DELIVERED_UNVERIFIED',
      'VERIFIED',
      'CLOSED',
      'NEEDS_REVIEW',
      'DUPLICATE',
      'EXPIRED',
      'REOPENED',
      'CANCELLED',
    ];
    for (const s of states) {
      const label = humanizeState(s);
      expect(label).not.toContain('_');
      expect(label).not.toMatch(/\b[A-Z]{2,}\b/); // no SHOUTING tokens
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

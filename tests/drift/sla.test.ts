import { describe, expect, it } from 'vitest';
import { computeSlaDueAtMs, SLA_MINUTES, slaBaseMinutes, slaDueAtIso } from '../../src/drift/sla';
import type { NeedType, Severity } from '../../src/ledger/types';

const TYPES: NeedType[] = ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

describe('SLA table', () => {
  it('anchors the §F4 values (medical 45, food 240, shelter 480 at critical)', () => {
    expect(slaBaseMinutes('medical', 'critical')).toBe(45);
    expect(slaBaseMinutes('food', 'critical')).toBe(240);
    expect(slaBaseMinutes('shelter', 'critical')).toBe(480);
  });

  it('defines a positive budget for every type × severity', () => {
    for (const type of TYPES) {
      for (const sev of SEVERITIES) {
        expect(slaBaseMinutes(type, sev), `${type}/${sev}`).toBeGreaterThan(0);
      }
    }
  });

  it('makes criticals the shortest within each type (severity relaxes the deadline)', () => {
    for (const type of TYPES) {
      const row = SLA_MINUTES[type];
      expect(row.critical, `${type} critical`).toBeLessThanOrEqual(row.high);
      expect(row.high, `${type} high`).toBeLessThanOrEqual(row.medium);
      expect(row.medium, `${type} medium`).toBeLessThanOrEqual(row.low);
    }
  });
});

describe('computeSlaDueAtMs', () => {
  const base = Date.parse('2026-07-06T00:00:00.000Z');

  it('adds baseMinutes in real time (multiplier 1)', () => {
    // medical/critical = 45 min = 2_700_000 ms.
    expect(computeSlaDueAtMs('medical', 'critical', base, 1)).toBe(base + 45 * 60_000);
  });

  it('defaults the multiplier to 1', () => {
    expect(computeSlaDueAtMs('food', 'critical', base)).toBe(base + 240 * 60_000);
  });

  it('compresses with the demo multiplier (0.02 → a 45-min SLA fires in 54s)', () => {
    const due = computeSlaDueAtMs('medical', 'critical', base, 0.02);
    expect(due - base).toBe(54_000); // 45 * 60_000 * 0.02
  });

  it('scales linearly with the multiplier', () => {
    const full = computeSlaDueAtMs('shelter', 'high', base, 1) - base;
    const half = computeSlaDueAtMs('shelter', 'high', base, 0.5) - base;
    expect(half).toBe(full / 2);
  });
});

describe('slaDueAtIso', () => {
  it('is the ISO form of computeSlaDueAtMs', () => {
    const base = Date.parse('2026-07-06T00:00:00.000Z');
    const iso = slaDueAtIso('water', 'medium', base, 1);
    expect(iso).toBe(new Date(computeSlaDueAtMs('water', 'medium', base, 1)).toISOString());
    expect(Date.parse(iso)).toBe(base + 240 * 60_000);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScenario } from '../../demo/scenarios/schema';
import { computeSlaDueAtMs, SLA_MINUTES, slaBaseMinutes } from '../../src/drift/sla';
import {
  DEFAULT_SLA_TABLE,
  type FullSlaTable,
  mergeSlaTable,
  type SlaOverrides,
  slaTableMinutes,
} from '../../src/drift/slaConfig';
import type { NeedType, Severity } from '../../src/ledger/types';

// Moonshot #5 — "same engine, different disaster, nothing recompiled". These tests pin the
// config-driven SLA table: DEFAULT_SLA_TABLE is byte-faithful to the original in-code table,
// mergeSlaTable deep-merges a partial override into a complete table, and the SAME
// computeSlaDueAtMs produces a DIFFERENT (honestly earlier/later) due time purely from the
// injected data. The final block loads the real heatwave-1.yaml scenario and proves its
// scenario-owned `sla:` block drives a distinct SLA regime through the unchanged engine.

const TYPES: NeedType[] = ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

const FLOOD_URL = new URL('../../demo/scenarios/flood-1.yaml', import.meta.url);
const HEATWAVE_URL = new URL('../../demo/scenarios/heatwave-1.yaml', import.meta.url);

describe('DEFAULT_SLA_TABLE', () => {
  it('is byte-faithful to the (backwards-compatible) SLA_MINUTES re-export', () => {
    expect(DEFAULT_SLA_TABLE).toBe(SLA_MINUTES);
    for (const type of TYPES) {
      for (const sev of SEVERITIES) {
        expect(DEFAULT_SLA_TABLE[type][sev], `${type}/${sev}`).toBe(SLA_MINUTES[type][sev]);
      }
    }
  });

  it('anchors the §F4 values (medical 45, food 240, shelter 480 at critical)', () => {
    expect(DEFAULT_SLA_TABLE.medical.critical).toBe(45);
    expect(DEFAULT_SLA_TABLE.food.critical).toBe(240);
    expect(DEFAULT_SLA_TABLE.shelter.critical).toBe(480);
  });

  it('is complete: a positive budget for every type × severity', () => {
    for (const type of TYPES) {
      for (const sev of SEVERITIES) {
        expect(DEFAULT_SLA_TABLE[type]?.[sev], `${type}/${sev}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('slaTableMinutes', () => {
  it('reads the given table when the cell is present', () => {
    const table = { ...DEFAULT_SLA_TABLE, medical: { ...DEFAULT_SLA_TABLE.medical, critical: 30 } };
    expect(slaTableMinutes('medical', 'critical', table)).toBe(30);
  });

  it('falls back to DEFAULT_SLA_TABLE for an omitted cell (no undefined leak)', () => {
    // A partial table that only defines medical/critical — every other lookup grounds on the default.
    const partial = { medical: { critical: 25 } } as unknown as Parameters<typeof slaTableMinutes>[2];
    expect(slaTableMinutes('medical', 'critical', partial)).toBe(25);
    expect(slaTableMinutes('shelter', 'low', partial)).toBe(DEFAULT_SLA_TABLE.shelter.low);
    expect(slaTableMinutes('water', 'high', partial)).toBe(DEFAULT_SLA_TABLE.water.high);
  });

  it('defaults to DEFAULT_SLA_TABLE when no table is passed', () => {
    expect(slaTableMinutes('food', 'critical')).toBe(240);
  });
});

describe('mergeSlaTable', () => {
  const assertComplete = (table: FullSlaTable): void => {
    for (const type of TYPES) {
      for (const sev of SEVERITIES) {
        expect(typeof table[type][sev], `${type}/${sev}`).toBe('number');
      }
    }
  };

  it('returns a complete copy of the default when given no overrides', () => {
    const merged = mergeSlaTable();
    assertComplete(merged);
    expect(merged).toEqual(DEFAULT_SLA_TABLE);
    expect(merged).not.toBe(DEFAULT_SLA_TABLE); // a fresh object, safe to hand out
  });

  it('overrides only the named cells and preserves every other cell', () => {
    const overrides: SlaOverrides = { medical: { critical: 30 }, water: { critical: 40 } };
    const merged = mergeSlaTable(overrides);
    assertComplete(merged);
    expect(merged.medical.critical).toBe(30); // changed
    expect(merged.water.critical).toBe(40); // changed
    expect(merged.medical.high).toBe(DEFAULT_SLA_TABLE.medical.high); // untouched severity kept
    expect(merged.shelter.critical).toBe(DEFAULT_SLA_TABLE.shelter.critical); // untouched type kept
    expect(merged.food).toEqual(DEFAULT_SLA_TABLE.food);
  });

  it('does not mutate DEFAULT_SLA_TABLE or the overrides input', () => {
    const overrides: SlaOverrides = { medical: { critical: 30 } };
    const frozenSnapshot = JSON.parse(JSON.stringify(DEFAULT_SLA_TABLE));
    mergeSlaTable(overrides);
    expect(DEFAULT_SLA_TABLE).toEqual(frozenSnapshot);
    expect(overrides).toEqual({ medical: { critical: 30 } });
  });
});

describe('computeSlaDueAtMs honors an injected table', () => {
  const base = Date.parse('2026-07-08T00:00:00.000Z');

  it('default table param preserves the original behaviour', () => {
    expect(computeSlaDueAtMs('medical', 'critical', base, 1)).toBe(base + 45 * 60_000);
    expect(slaBaseMinutes('medical', 'critical')).toBe(45);
  });

  it('a shorter override table produces a genuinely earlier due time (honest, not faked)', () => {
    const heat = mergeSlaTable({ medical: { critical: 30 } });
    const withDefault = computeSlaDueAtMs('medical', 'critical', base, 1);
    const withOverride = computeSlaDueAtMs('medical', 'critical', base, 1, heat);
    expect(withOverride).toBeLessThan(withDefault);
    expect(withOverride - base).toBe(30 * 60_000);
  });

  it('applies the demo multiplier on top of the override on the same path', () => {
    const heat = mergeSlaTable({ water: { critical: 40 } });
    expect(computeSlaDueAtMs('water', 'critical', base, 0.02, heat) - base).toBe(40 * 60_000 * 0.02);
  });
});

describe('second scenario (heatwave-1.yaml) — config-only SLA regime on the same engine', () => {
  const heatwave = parseScenario(readFileSync(HEATWAVE_URL, 'utf8'));
  const flood = parseScenario(readFileSync(FLOOD_URL, 'utf8'));

  it('flood-1 carries no sla block → its merged table is the untouched default', () => {
    expect(flood.sla).toBeUndefined();
    expect(mergeSlaTable(flood.sla)).toEqual(DEFAULT_SLA_TABLE);
  });

  it('heatwave-1 carries a validated sla override block', () => {
    expect(heatwave.sla).toBeDefined();
    expect(heatwave.sla?.medical?.critical).toBe(30);
    expect(heatwave.sla?.water?.critical).toBe(40);
  });

  it('the merged heatwave table is distinct from flood exactly where the scenario says, and identical elsewhere', () => {
    const floodTable = mergeSlaTable(flood.sla);
    const heatTable = mergeSlaTable(heatwave.sla);
    // Distinct on the overridden cells (heat kills faster: dehydration/heatstroke shorter).
    expect(heatTable.medical.critical).toBe(30);
    expect(floodTable.medical.critical).toBe(45);
    expect(heatTable.water.critical).toBe(40);
    expect(floodTable.water.critical).toBe(60);
    // Identical on every cell the scenario did NOT override (same engine, same defaults).
    expect(heatTable.shelter).toEqual(floodTable.shelter);
    expect(heatTable.food).toEqual(floodTable.food);
    expect(heatTable.rescue).toEqual(floodTable.rescue);
    expect(heatTable.transport).toEqual(floodTable.transport);
  });

  it('the SAME computeSlaDueAtMs yields an earlier medical-critical deadline for heatwave than flood', () => {
    const assignedAt = Date.parse('2026-07-08T12:00:00.000Z');
    const m = heatwave.sla_multiplier; // both scenarios compress identically; only the table differs
    const floodDue = computeSlaDueAtMs('medical', 'critical', assignedAt, m, mergeSlaTable(flood.sla));
    const heatDue = computeSlaDueAtMs('medical', 'critical', assignedAt, m, mergeSlaTable(heatwave.sla));
    expect(heatDue).toBeLessThan(floodDue);
    expect(heatDue - assignedAt).toBe(30 * 60_000 * m);
    expect(floodDue - assignedAt).toBe(45 * 60_000 * m);
  });
});

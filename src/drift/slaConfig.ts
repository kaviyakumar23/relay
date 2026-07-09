import type { NeedType, Severity } from '../ledger/types';

// SLA config (BUILD-DOC §F4 · Moonshot #5 "same engine, different disaster, nothing
// recompiled"). The SLA budget table was born in code (drift/sla.ts SLA_MINUTES). This
// module lifts it to CONFIG: a data structure a scenario/org can supply or override, so a
// second disaster (heatwave) runs the SAME computeSlaDueAtMs / driftEngine / state machine
// with nothing but a different table. No domain logic forks — only DATA changes.
//
// Two shapes, on purpose:
//   • FullSlaTable  — every (type × severity) has a budget. DEFAULT_SLA_TABLE is one, and
//     mergeSlaTable always RETURNS one, so runtime lookups never fall through to undefined.
//   • SlaTable / SlaOverrides — PARTIAL: a scenario names only the cells it changes and the
//     rest fall back to the default. This is the injectable/override shape (the scenario
//     `sla:` block in demo/scenarios/schema.ts has exactly this structure).
//
// Budgets are REAL-WORLD minutes. The demo clock compression is a SEPARATE multiplier
// (drift/sla.ts) applied on the same path — the table itself stays honest.

/** A complete SLA table: every need type maps every severity to a budget in minutes. */
export type FullSlaTable = Record<NeedType, Record<Severity, number>>;

/** A (possibly partial) SLA table — the config/override shape. Any cell omitted here falls
 * back to DEFAULT_SLA_TABLE when merged/looked up. Mirrors the scenario `sla` block. */
export type SlaTable = Record<NeedType, Partial<Record<Severity, number>>>;

/** Per-scenario/org overrides: any subset of types, any subset of severities. */
export type SlaOverrides = Partial<Record<NeedType, Partial<Record<Severity, number>>>>;

/**
 * The default SLA budget table (real-world minutes) — mirrors drift/sla.ts's original
 * SLA_MINUTES EXACTLY, so lifting the table to config changes NO behaviour and every
 * existing test still passes. Anchors from §F4: medical critical 45, food critical 240
 * (4 h), shelter critical 480 (8 h). Within a type criticals are shortest and each lower
 * severity relaxes the deadline; ordered roughly by life-threat.
 */
export const DEFAULT_SLA_TABLE: FullSlaTable = {
  rescue: { critical: 30, high: 60, medium: 120, low: 240 },
  medical: { critical: 45, high: 90, medium: 180, low: 360 },
  water: { critical: 60, high: 120, medium: 240, low: 480 },
  transport: { critical: 90, high: 180, medium: 360, low: 720 },
  food: { critical: 240, high: 360, medium: 480, low: 720 },
  other: { critical: 120, high: 240, medium: 480, low: 960 },
  shelter: { critical: 480, high: 720, medium: 960, low: 1440 },
};

const NEED_TYPES = Object.keys(DEFAULT_SLA_TABLE) as NeedType[];
const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/**
 * Resolve one (type × severity) budget in minutes from a (possibly partial) table, falling
 * back to DEFAULT_SLA_TABLE for any cell the table omits. Always returns a positive number —
 * no non-null assertions, no undefined leaks (the default is complete, so the `??` grounds).
 */
export function slaTableMinutes(type: NeedType, severity: Severity, table: SlaTable = DEFAULT_SLA_TABLE): number {
  return table[type]?.[severity] ?? DEFAULT_SLA_TABLE[type][severity];
}

/**
 * Merge partial overrides over DEFAULT_SLA_TABLE into a COMPLETE table. Deep per cell: an
 * override may touch a single (type, severity) and every other cell keeps the default. Pure —
 * never mutates the default or the input. This is the loader a scenario/org uses:
 *
 *   const table = mergeSlaTable(scenario.sla);   // full, ready for computeSlaDueAtMs(..., table)
 *
 * Passing `undefined` (a scenario with no `sla` block) yields a copy of DEFAULT_SLA_TABLE, so
 * flood-1 and heatwave-1 travel the identical code path — the only difference is this data.
 */
export function mergeSlaTable(overrides?: SlaOverrides): FullSlaTable {
  const merged = {} as FullSlaTable;
  for (const type of NEED_TYPES) {
    const row = {} as Record<Severity, number>;
    for (const severity of SEVERITIES) {
      row[severity] = overrides?.[type]?.[severity] ?? DEFAULT_SLA_TABLE[type][severity];
    }
    merged[type] = row;
  }
  return merged;
}

import type { NeedType, Severity } from '../ledger/types';
import { DEFAULT_SLA_TABLE, type SlaTable, slaTableMinutes } from './slaConfig';

// SLA clock (BUILD-DOC §F4). "Claim/assign creates an Obligation with sla_due_at from a
// per-type table (critical medical: 45 min; food: 4 h; shelter: 8 h) — config, not code."
// This module is the pure arithmetic over that table; it owns NO state and does NO I/O. The
// Assign/Claim handler calls computeSlaDueAtMs at the moment of assignment and stamps the
// result onto the Assigned/Claimed event.
//
// The TABLE itself now lives in drift/slaConfig.ts (DEFAULT_SLA_TABLE) so it can be config-
// driven per scenario/org (Moonshot #5): every function here takes an OPTIONAL `table` that
// defaults to DEFAULT_SLA_TABLE, so the runtime and all existing callers/tests are unchanged,
// while a second scenario can pass a merged override table into the SAME arithmetic — no fork.
//
// Compression for the demo (§12.3) is a MULTIPLIER the caller passes in (config.slaMultiplier,
// default 1). 0.02 turns a 45-min SLA into ~54s so drift fires on camera. The table stays in
// real-world minutes; only the multiplier is demo-aware, and it is labeled for judges.

/**
 * The default per-(type × severity) SLA table, in real-world minutes. Backwards-compatible
 * re-export of drift/slaConfig's DEFAULT_SLA_TABLE (the canonical, now config-driven source)
 * under the original name + shape, so existing importers (surfaces/appHome, tests) are stable.
 */
export const SLA_MINUTES: Record<NeedType, Record<Severity, number>> = DEFAULT_SLA_TABLE;

/** The base SLA budget (real-world minutes) for a need of this type + severity. Reads from the
 * given table (default = DEFAULT_SLA_TABLE), falling back to the default for any omitted cell. */
export function slaBaseMinutes(type: NeedType, severity: Severity, table: SlaTable = DEFAULT_SLA_TABLE): number {
  return slaTableMinutes(type, severity, table);
}

/**
 * When this obligation is due, in epoch ms: assignedAt + budget compressed by the multiplier.
 * Pure. `multiplier` defaults to 1 (real time); callers pass config.slaMultiplier so the demo
 * clock (0.02) compresses on the same path. `table` defaults to DEFAULT_SLA_TABLE, so passing a
 * merged scenario-override table (mergeSlaTable) runs a different SLA regime through this exact
 * arithmetic — the only difference is the data.
 */
export function computeSlaDueAtMs(
  type: NeedType,
  severity: Severity,
  assignedAtMs: number,
  multiplier = 1,
  table: SlaTable = DEFAULT_SLA_TABLE,
): number {
  return assignedAtMs + slaBaseMinutes(type, severity, table) * 60_000 * multiplier;
}

/** The same due time as an ISO string, ready to stamp onto an Assigned/Claimed event. */
export function slaDueAtIso(
  type: NeedType,
  severity: Severity,
  assignedAtMs: number,
  multiplier = 1,
  table: SlaTable = DEFAULT_SLA_TABLE,
): string {
  return new Date(computeSlaDueAtMs(type, severity, assignedAtMs, multiplier, table)).toISOString();
}

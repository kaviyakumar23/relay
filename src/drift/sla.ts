import type { NeedType, Severity } from '../ledger/types';

// SLA clock (BUILD-DOC §F4). "Claim/assign creates an Obligation with sla_due_at
// from a per-type table (critical medical: 45 min; food: 4 h; shelter: 8 h) —
// config, not code." This module is the config + the pure arithmetic; it owns NO
// state and does NO I/O. The Assign/Claim handler calls computeSlaDueAtMs at the
// moment of assignment and stamps the result onto the Assigned/Claimed event.
//
// Compression for the demo (§12.3) is a MULTIPLIER the caller passes in
// (config.slaMultiplier, default 1). 0.02 turns a 45-min SLA into ~54s so drift
// fires on camera. The table stays in real-world minutes; only the multiplier is
// demo-aware, and it is labeled for judges.

/**
 * Base SLA in minutes for every (type × severity). Anchors from §F4: medical
 * critical 45, food critical 240 (4 h), shelter critical 480 (8 h). Within a
 * type, criticals are shortest and each lower severity relaxes the deadline.
 * Ordered roughly by life-threat: rescue/medical shortest, shelter longest.
 */
export const SLA_MINUTES: Record<NeedType, Record<Severity, number>> = {
  rescue: { critical: 30, high: 60, medium: 120, low: 240 },
  medical: { critical: 45, high: 90, medium: 180, low: 360 },
  water: { critical: 60, high: 120, medium: 240, low: 480 },
  transport: { critical: 90, high: 180, medium: 360, low: 720 },
  food: { critical: 240, high: 360, medium: 480, low: 720 },
  other: { critical: 120, high: 240, medium: 480, low: 960 },
  shelter: { critical: 480, high: 720, medium: 960, low: 1440 },
};

/** The base SLA budget (real-world minutes) for a need of this type + severity. */
export function slaBaseMinutes(type: NeedType, severity: Severity): number {
  return SLA_MINUTES[type][severity];
}

/**
 * When this obligation is due, in epoch ms: assignedAt + budget compressed by the
 * multiplier. Pure. `multiplier` defaults to 1 (real time); callers pass
 * config.slaMultiplier so the demo clock (0.02) compresses on the same path.
 */
export function computeSlaDueAtMs(type: NeedType, severity: Severity, assignedAtMs: number, multiplier = 1): number {
  return assignedAtMs + slaBaseMinutes(type, severity) * 60_000 * multiplier;
}

/** The same due time as an ISO string, ready to stamp onto an Assigned/Claimed event. */
export function slaDueAtIso(type: NeedType, severity: Severity, assignedAtMs: number, multiplier = 1): string {
  return new Date(computeSlaDueAtMs(type, severity, assignedAtMs, multiplier)).toISOString();
}

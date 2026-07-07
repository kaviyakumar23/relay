import { meetsVerificationPolicy } from '../ledger/stateMachine';
import type { EvidenceKind, ProjectedNeed, Severity } from '../ledger/types';

// Verification-level helpers (BUILD-DOC §F5). The ledger state machine is the SINGLE
// SOURCE OF TRUTH for the close policy: a `Verified` event is rejected by decide() unless
// meetsVerificationPolicy holds. We import that predicate directly here so this display
// surface can never silently disagree with the engine that actually gates verification.
//
// Graduated levels (BUILD-DOC §6.2 rule 3):
//   L0 self-report · L1 photo + locality_confirm · L2 recipient_confirm · L3 coordinator_signoff
// Policy: critical|high verify at L3 (with L1+L2 present); medium|low at L2. The severity
// split and the per-severity required set below mirror the engine FOR DISPLAY ONLY.

/** Mirrors stateMachine.isHighSeverity, which is not exported. stateMachine remains the
 *  source of truth for the policy — keep this byte-identical: critical|high verify at L3. */
const isHighSeverity = (s: Severity): boolean => s === 'critical' || s === 'high';

/** Human labels for each evidence kind — reused by the signoff hint + the evidence packet. */
export const EVIDENCE_KIND_LABEL: Record<EvidenceKind, string> = {
  photo: 'photo',
  locality_confirm: 'location',
  recipient_confirm: 'recipient confirmation',
  coordinator_signoff: 'coordinator sign-off',
};

/** Canonical ordering for the `missing` list + the packet (matches the L1→L3 progression). */
const KIND_ORDER: readonly EvidenceKind[] = ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff'];

/** critical|high close at L3 — the full packet. */
const REQUIRED_HIGH: readonly EvidenceKind[] = KIND_ORDER;
/** medium|low close at L2 — recipient confirmation only. */
const REQUIRED_LOW: readonly EvidenceKind[] = ['recipient_confirm'];

const LEVEL_LABEL: Record<0 | 1 | 2 | 3, string> = {
  0: 'L0 (self-report)',
  1: 'L1 (photo + location)',
  2: 'L2 (recipient confirmed)',
  3: 'L3 (coordinator sign-off)',
};

export interface VerificationStatus {
  /** Highest fully-satisfied verification level (each level checked independently). */
  level: 0 | 1 | 2 | 3;
  label: string;
  /** photo AND locality_confirm both present. */
  haveL1: boolean;
  /** recipient_confirm present. */
  haveL2: boolean;
  /** coordinator_signoff present. */
  haveL3: boolean;
  /** Evidence kinds still needed to satisfy THIS severity's policy (canonical order). */
  missing: EvidenceKind[];
  /** Mirrors the engine: true iff a Verified event would be accepted right now. */
  meetsPolicy: boolean;
  /** The policy target for this severity, e.g. 'L3 (photo + location + recipient + sign-off)'. */
  requiredLabel: string;
}

/**
 * Derive the verification status of a need purely from its evidence packet + severity.
 * `meetsPolicy` is delegated to the engine's meetsVerificationPolicy so the UI and the
 * ledger cannot drift; `level`, `missing`, and the labels are presentation over the same
 * facts. Pure — no Slack client, no store.
 */
export function verificationStatus(need: ProjectedNeed): VerificationStatus {
  const kinds = new Set(need.evidence.map((e) => e.kind));
  const haveL1 = kinds.has('photo') && kinds.has('locality_confirm');
  const haveL2 = kinds.has('recipient_confirm');
  const haveL3 = kinds.has('coordinator_signoff');

  // Highest fully-satisfied level (levels are independent; take the max satisfied index).
  let level: 0 | 1 | 2 | 3 = 0;
  if (haveL1) level = 1;
  if (haveL2) level = 2;
  if (haveL3) level = 3;

  const high = isHighSeverity(need.severity);
  const required = high ? REQUIRED_HIGH : REQUIRED_LOW;
  const missing = KIND_ORDER.filter((k) => required.includes(k) && !kinds.has(k));
  const requiredLabel = high ? 'L3 (photo + location + recipient + sign-off)' : 'L2 (recipient confirmation)';

  return {
    level,
    label: LEVEL_LABEL[level],
    haveL1,
    haveL2,
    haveL3,
    missing,
    meetsPolicy: meetsVerificationPolicy(need),
    requiredLabel,
  };
}

/** Result of the sign-off precheck: whether a coordinator sign-off may be recorded now, and if
 * not, which prerequisite evidence kinds are still missing (canonical order). */
export interface SignOffCheck {
  allowed: boolean;
  missing: EvidenceKind[];
}

/**
 * Pure precheck for the "Sign off & close" action: is EVERYTHING the severity policy requires
 * EXCEPT the coordinator sign-off itself already attached? Sign-off is the last step in the L3
 * packet, so it may only be recorded once photo + location + recipient are present (critical|high);
 * for medium|low the policy is met at L2 (recipient confirmation) with no sign-off required, so
 * the recipient confirmation is the only prerequisite.
 *
 * The integrator MUST call this before dispatching EvidenceAttached(coordinator_signoff) /
 * CoordinatorSignedOff, and no-op with a "missing: X" hint when `allowed` is false — otherwise a
 * prematurely-clicked (visually locked) button still records the event. Pure — no store, no Slack.
 */
export function canSignOff(need: ProjectedNeed): SignOffCheck {
  const kinds = new Set(need.evidence.map((e) => e.kind));
  const required = isHighSeverity(need.severity) ? REQUIRED_HIGH : REQUIRED_LOW;
  // Everything the policy needs EXCEPT the sign-off itself must already be attached.
  const prerequisites = new Set<EvidenceKind>(required.filter((k) => k !== 'coordinator_signoff'));
  const missing = KIND_ORDER.filter((k) => prerequisites.has(k) && !kinds.has(k));
  return { allowed: missing.length === 0, missing };
}

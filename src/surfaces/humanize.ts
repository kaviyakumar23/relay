import type { NeedState } from '../ledger/types';

// Display-only copy for the need lifecycle states. The ledger, logs, and audit trail keep the
// raw enum (NEEDS_REVIEW, DELIVERED_UNVERIFIED, …) — this helper is purely for human-facing
// surfaces (App Home counters, card fallback text) so operators read "Needs review" instead of a
// SHOUTING_ENUM. Exhaustive over NeedState so a new state can't silently fall through untranslated.

const STATE_LABELS: Record<NeedState, string> = {
  NEW: 'New',
  NEEDS_REVIEW: 'Needs review',
  TRIAGED: 'Triaged',
  OPEN: 'Open',
  MATCH_SUGGESTED: 'Match suggested',
  CLAIMED: 'Claimed',
  IN_PROGRESS: 'In progress',
  DELIVERED_UNVERIFIED: 'Delivered · unverified',
  VERIFIED: 'Verified',
  CLOSED: 'Closed',
  DUPLICATE: 'Merged',
  EXPIRED: 'Expired',
  REOPENED: 'Reopened',
  CANCELLED: 'Cancelled',
};

/** Human-facing label for a need state (Title-case, spaces, no underscores). Display only —
 * never use for logs, audit rows, or business keys, which must carry the raw enum. */
export function humanizeState(state: NeedState): string {
  return STATE_LABELS[state] ?? state.replace(/_/g, ' ');
}

import type { NeedType, ProjectedNeed, Severity } from '../ledger/types';

// App Home board filters (BUILD-DOC §F2, filters row). Pure types + pure filtering +
// encode/decode for the Block Kit action value. No Slack client, no store, no clock —
// appHome.ts renders the filter buttons and the integrator round-trips the encoded
// value back through decodeHomeFilter to re-publish a narrowed board.
//
// Integrator wiring: app.action('home_filter') → decodeHomeFilter(action.value) →
// store the result per-user in a small in-memory Map → publishHome(user, needs,
// { now, filter }). The 'All' reset decodes to null (no filter).

/** One active board filter. `null` (no filter) is the "All" reset. */
export type HomeFilter =
  | { kind: 'type'; value: NeedType }
  | { kind: 'severity'; value: Severity }
  | { kind: 'locality'; value: number };

/** Canonical enumerations, used both to order buttons and to validate a decoded value. */
export const NEED_TYPES: readonly NeedType[] = ['medical', 'rescue', 'water', 'transport', 'food', 'shelter', 'other'];
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

const isNeedType = (s: string): s is NeedType => (NEED_TYPES as readonly string[]).includes(s);
const isSeverity = (s: string): s is Severity => (SEVERITIES as readonly string[]).includes(s);

/** Narrow a need list to the active filter. Pure. A `null`/absent filter returns the list as-is. */
export function applyHomeFilter(needs: ProjectedNeed[], filter?: HomeFilter | null): ProjectedNeed[] {
  if (!filter) return needs;
  switch (filter.kind) {
    case 'type':
      return needs.filter((n) => n.type === filter.value);
    case 'severity':
      return needs.filter((n) => n.severity === filter.value);
    case 'locality':
      return needs.filter((n) => n.locality_id === filter.value);
  }
}

/** The sentinel the "All" reset button carries; decodeHomeFilter maps it back to null. */
export const HOME_FILTER_ALL = 'all';

/**
 * Encode a filter into the Block Kit action value (which also becomes the entity id of
 * `home_filter:<value>`). Packs `<kind>|<value>` — split on the FIRST '|' — matching the
 * repo's two-part entity-id convention (matchCard/needCard). `null` → 'all'.
 */
export function encodeHomeFilter(filter: HomeFilter | null): string {
  if (!filter) return HOME_FILTER_ALL;
  return `${filter.kind}|${filter.value}`;
}

/** Recover a filter from the encoded action value. 'all' / unknown / malformed → null. */
export function decodeHomeFilter(encoded: string): HomeFilter | null {
  const i = encoded.indexOf('|');
  if (i < 0) return null;
  const kind = encoded.slice(0, i);
  const raw = encoded.slice(i + 1);
  if (kind === 'type') return isNeedType(raw) ? { kind: 'type', value: raw } : null;
  if (kind === 'severity') return isSeverity(raw) ? { kind: 'severity', value: raw } : null;
  if (kind === 'locality') {
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) ? { kind: 'locality', value: n } : null;
  }
  return null;
}

/** A short human label for the active filter (context line / accessibility). */
export function filterLabel(filter: HomeFilter | null): string {
  if (!filter) return 'All needs';
  if (filter.kind === 'locality') return `Locality #${filter.value}`;
  const noun = filter.kind === 'type' ? 'Type' : 'Severity';
  return `${noun}: ${filter.value}`;
}

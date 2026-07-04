import type { NeedState, ProjectedNeed } from '../ledger/types';
import { context, divider, fields, header, type SlackView, section } from './primitives';

// The App Home operations board (BUILD-DOC §F2). Day-1 version: live counters by
// status derived purely from projections, plus the "How Relay decides"
// transparency note (§11.3) that states Relay's human-authority stance in plain
// language. Urgent lists, drift section, and filters arrive with later phases.

/** The status buckets shown on the board, in lifecycle order. */
const STATUS_ORDER: readonly NeedState[] = [
  'NEW',
  'NEEDS_REVIEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
  'VERIFIED',
  'CLOSED',
];

const STATUS_EMOJI: Record<NeedState, string> = {
  NEW: ':new:',
  NEEDS_REVIEW: ':warning:',
  TRIAGED: ':clipboard:',
  OPEN: ':large_blue_circle:',
  MATCH_SUGGESTED: ':handshake:',
  CLAIMED: ':raising_hand:',
  IN_PROGRESS: ':truck:',
  DELIVERED_UNVERIFIED: ':package:',
  VERIFIED: ':white_check_mark:',
  CLOSED: ':lock:',
  DUPLICATE: ':link:',
  EXPIRED: ':hourglass:',
  REOPENED: ':arrows_counterclockwise:',
  CANCELLED: ':no_entry_sign:',
};

export interface HomeStats {
  total: number;
  byStatus: Record<NeedState, number>;
}

/** Tally needs by their current projected state. */
export function homeStats(needs: ProjectedNeed[]): HomeStats {
  const byStatus = Object.fromEntries((Object.keys(STATUS_EMOJI) as NeedState[]).map((s) => [s, 0])) as Record<
    NeedState,
    number
  >;
  for (const n of needs) byStatus[n.state] += 1;
  return { total: needs.length, byStatus };
}

/** Build the App Home view (a `home` surface) for the given needs. */
export function appHomeView(needs: ProjectedNeed[]): SlackView {
  const stats = homeStats(needs);
  const blocks = [
    header('Relay · operations board'),
    context('Every need tracked, every promise proven. Numbers are live projections of the append-only ledger.'),
  ];

  if (stats.total === 0) {
    blocks.push(section('_No needs yet. As messages arrive in #relay-intake, dispatch cards will appear here._'));
  } else {
    blocks.push(section(`*${stats.total}* need${stats.total === 1 ? '' : 's'} in the ledger`));
    // Two-column counter grid, only for buckets that have needs (keeps it scannable).
    const populated = STATUS_ORDER.filter((s) => stats.byStatus[s] > 0);
    if (populated.length > 0) {
      blocks.push(fields(populated.map((s) => `${STATUS_EMOJI[s]} *${s}:* ${stats.byStatus[s]}`)));
    }
  }

  blocks.push(
    divider,
    section(
      '*How Relay decides*\n' +
        'Relay never treats a single message as truth. The AI interprets language; deterministic code controls state; ' +
        'a human confirms every consequential transition (confirm, assign, merge, verify-close). ' +
        'Severity floors can only ever rise, and nothing closes on someone’s word alone — delivery is proven by evidence.',
    ),
  );

  return { type: 'home', blocks };
}

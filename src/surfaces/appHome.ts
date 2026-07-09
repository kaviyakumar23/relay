import { SLA_MINUTES } from '../drift/sla';
import type { NeedState, NeedType, ProjectedNeed, Severity } from '../ledger/types';
import { TERMINAL_STATES } from '../ledger/types';
import { applyHomeFilter, encodeHomeFilter, filterLabel, type HomeFilter } from './homeFilters';
import {
  ACTIONS,
  actionId,
  actions,
  button,
  context,
  divider,
  escapeMrkdwn,
  fields,
  header,
  type SlackBlock,
  type SlackView,
  section,
} from './primitives';

// The App Home operations board (BUILD-DOC §F2). A single `home` view, PURE over the
// need projections (+ now/filter/slaMultiplier), rebuilt on every publish. Six sections,
// in order: live counters (incl. "verified today"), a "needs your attention" list, the
// drifting-obligations panel, a filters row, the config panel (verification policy + SLA
// table), and the "How Relay decides" transparency note. Nothing here holds state or
// touches Slack — the integrator re-publishes this after every ledger mutation and on
// each live drift tick, threading the viewer's active filter through opts.
//
// Public labels: ProjectedNeed carries `need_id` (a UUID), not the N-000x public id — the
// store owns that mapping. Pass `opts.publicIdOf` (memoize the store's getPublicId) to
// render N-000x; absent, rows fall back to a short `#<uuid-prefix>` so the board still
// renders in pure/hermetic tests.

/** The status buckets shown on the counter grid, in lifecycle order. */
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

/** Severity chips (matches the dispatch card): critical 🔴 · high 🟠 · medium 🟡 · low 🟢. */
const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🟢',
};

const SEV_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const TYPE_ORDER: readonly NeedType[] = ['medical', 'rescue', 'water', 'transport', 'food', 'shelter', 'other'];

/** Pre-commit states — a critical one here is the single highest-priority item on the board. */
const OPEN_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'NEW',
  'TRIAGED',
  'OPEN',
  'NEEDS_REVIEW',
  'MATCH_SUGGESTED',
  'REOPENED',
]);

/** How many rows the attention list and the drift panel each show before summarising. */
const ATTENTION_LIMIT = 6;
const DRIFT_LIMIT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * "Verified today" — needs currently VERIFIED or CLOSED whose last projection update is
 * within the last 24h. APPROXIMATION: the projection exposes `updated_at`, not the ts of
 * the Verified/Closed event itself, so a later CommentAdded/Reopened would move the clock.
 * For a live ops glance this is close enough; an exact count would read need_events.
 */
export function verifiedTodayCount(needs: ProjectedNeed[], now: number): number {
  const cutoff = now - DAY_MS;
  return needs.filter((n) => (n.state === 'VERIFIED' || n.state === 'CLOSED') && Date.parse(n.updated_at) >= cutoff)
    .length;
}

/** Options for the board. `now` is injected for purity (defaults to the wall clock on the
 * live publish path); `filter` narrows the whole board; `slaMultiplier` labels demo
 * compression; `publicIdOf` resolves N-000x labels (see file header). */
export interface HomeViewOptions {
  now?: number;
  filter?: HomeFilter | null;
  slaMultiplier?: number;
  publicIdOf?: (needId: string) => string | undefined;
  /** True while the "/relay demo degrade llm" toggle is on: render an honest AI-DEGRADED banner
   * so the judge always sees the operations board is running on heuristics (no LLM). */
  degraded?: boolean;
}

type LabelFn = (need: ProjectedNeed) => string;

/** UTC minute-precision stamp for the as-of line. */
function asOfLabel(now: number): string {
  return `${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Minutes → compact human budget for the SLA table: 45→45m, 90→1h30m, 240→4h. */
function humanMinutes(mins: number): string {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Milliseconds → compact human duration for drift deltas: 42m, 1h 12m. */
function humanDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** A PII-free locality label: the derived location text, else a locality id, else unknown. */
function localityLabel(need: ProjectedNeed): string {
  if (need.location_text) return escapeMrkdwn(need.location_text);
  if (need.locality_id !== null) return `locality #${need.locality_id}`;
  return 'location unknown';
}

/** A short status/flag badge: drift flags win, else the current state in words. */
function statusBadge(need: ProjectedNeed): string {
  if (need.flags.is_drifting) return '⚠️ drifting';
  if (need.flags.is_at_risk) return '⏳ at risk';
  return need.state.replace(/_/g, ' ').toLowerCase();
}

// --- attention list ---------------------------------------------------------

/** Ranking bucket (lower = more urgent): open-critical → drifting → at-risk → the rest. */
function attentionRank(n: ProjectedNeed): number {
  if (OPEN_STATES.has(n.state) && n.severity === 'critical') return 0;
  if (n.flags.is_drifting) return 1;
  if (n.flags.is_at_risk) return 2;
  return 3;
}

/** The top active needs waiting on a human, ranked, oldest-first within a bucket. */
function attentionNeeds(needs: ProjectedNeed[], limit: number): ProjectedNeed[] {
  return needs
    .filter((n) => !TERMINAL_STATES.has(n.state))
    .sort((a, b) => attentionRank(a) - attentionRank(b) || Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, limit);
}

/** The View button — action id encodes the need id; value carries the source permalink
 * (or the need id when no permalink) so the handler can deep-link straight to the thread. */
function viewButton(need: ProjectedNeed): SlackBlock {
  return {
    type: 'button',
    text: { type: 'plain_text', text: 'View', emoji: true },
    action_id: actionId('home_view', need.need_id),
    value: need.source.permalink ?? need.need_id,
  };
}

/** A quick deep action for the row's state: Confirm (triage) or Assign (commit), where legal. */
function quickAction(need: ProjectedNeed): SlackBlock | null {
  if (need.state === 'TRIAGED' || need.state === 'NEEDS_REVIEW') {
    return button('Confirm', ACTIONS.confirm, need.need_id, 'primary');
  }
  if (need.state === 'OPEN' || need.state === 'MATCH_SUGGESTED' || need.state === 'REOPENED') {
    return button('Assign', ACTIONS.assign, need.need_id, 'primary');
  }
  return null;
}

function attentionBlocks(needs: ProjectedNeed[], label: LabelFn): SlackBlock[] {
  const out: SlackBlock[] = [];
  for (const n of needs) {
    const line = `${SEVERITY_EMOJI[n.severity]} *${n.type}* · ${label(n)} · ${localityLabel(n)}  ·  \`${statusBadge(n)}\``;
    out.push({ type: 'section', text: { type: 'mrkdwn', text: line }, accessory: viewButton(n) });
    const quick = quickAction(n);
    if (quick) out.push(actions([quick]));
  }
  return out;
}

// --- drifting obligations ---------------------------------------------------

/** How far past / near the SLA this obligation is, relative to now. */
function slaDelta(need: ProjectedNeed, now: number): string {
  if (!need.sla_due_at) return 'no SLA set';
  const delta = now - Date.parse(need.sla_due_at);
  return delta >= 0 ? `${humanDuration(delta)} past SLA` : `due in ${humanDuration(-delta)}`;
}

function driftLine(need: ProjectedNeed, now: number, label: LabelFn): string {
  const badge = need.flags.is_drifting ? '⚠️' : '⏳';
  const who = need.assigned_volunteer_id !== null ? `<@${need.assigned_volunteer_id}>` : '_unassigned_';
  return `${badge} *${label(need)}* · ${need.type} in ${localityLabel(need)} — ${who} · ${slaDelta(need, now)}`;
}

function driftBlocks(needs: ProjectedNeed[], now: number, label: LabelFn): SlackBlock[] {
  const drifting = needs
    .filter((n) => n.flags.is_drifting || n.flags.is_at_risk)
    .sort((a, b) => {
      const fa = a.flags.is_drifting ? 0 : 1;
      const fb = b.flags.is_drifting ? 0 : 1;
      if (fa !== fb) return fa - fb;
      const da = a.sla_due_at ? Date.parse(a.sla_due_at) : Number.POSITIVE_INFINITY;
      const db = b.sla_due_at ? Date.parse(b.sla_due_at) : Number.POSITIVE_INFINITY;
      return da - db;
    });
  if (drifting.length === 0) {
    return [context('✅ *No obligations drifting* — every committed delivery is on track.')];
  }
  const shown = drifting.slice(0, DRIFT_LIMIT);
  const out = shown.map((n) => section(driftLine(n, now, label)));
  if (drifting.length > shown.length) {
    out.push(context(`_…and ${drifting.length - shown.length} more drifting._`));
  }
  return out;
}

// --- filters row ------------------------------------------------------------

const presentTypes = (needs: ProjectedNeed[]): NeedType[] => {
  const set = new Set(needs.map((n) => n.type));
  return TYPE_ORDER.filter((t) => set.has(t));
};

const presentSeverities = (needs: ProjectedNeed[]): Severity[] => {
  const set = new Set(needs.map((n) => n.severity));
  return SEV_ORDER.filter((s) => set.has(s));
};

/** The most-reported localities, by need count, with a display label for each. */
function topLocalities(needs: ProjectedNeed[], limit: number): { id: number; label: string }[] {
  const counts = new Map<number, { count: number; label: string }>();
  for (const n of needs) {
    if (n.locality_id === null) continue;
    const cur = counts.get(n.locality_id);
    if (cur) cur.count += 1;
    else counts.set(n.locality_id, { count: 1, label: n.location_text ?? `#${n.locality_id}` });
  }
  return [...counts.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0] - b[0])
    .slice(0, limit)
    .map(([id, v]) => ({ id, label: v.label }));
}

/** One filter button; the active filter renders `primary` so the selection is visible. */
function filterButton(filter: HomeFilter | null, text: string, active: HomeFilter | null): SlackBlock {
  const encoded = encodeHomeFilter(filter);
  const selected = encodeHomeFilter(active) === encoded;
  return button(text, 'home_filter', encoded, selected ? 'primary' : undefined);
}

function filterBlocks(allNeeds: ProjectedNeed[], active: HomeFilter | null): SlackBlock[] {
  if (allNeeds.length === 0) return [];
  const out: SlackBlock[] = [context('*Filter the board*')];
  const typeButtons = presentTypes(allNeeds).map((t) => filterButton({ kind: 'type', value: t }, t, active));
  const sevButtons = presentSeverities(allNeeds).map((s) =>
    filterButton({ kind: 'severity', value: s }, `${SEVERITY_EMOJI[s]} ${s}`, active),
  );
  const locButtons = topLocalities(allNeeds, 3).map((l) =>
    filterButton({ kind: 'locality', value: l.id }, l.label, active),
  );
  if (typeButtons.length > 0) out.push(actions(typeButtons));
  if (sevButtons.length > 0) out.push(actions(sevButtons));
  out.push(actions([...locButtons, filterButton(null, 'All', active)]));
  return out;
}

// --- config panel -----------------------------------------------------------

/** The verification policy + SLA table, rendered readably. Mirrors stateMachine's
 * meetsVerificationPolicy and drift/sla's SLA_MINUTES so judges see the rules the engine
 * actually enforces (kept byte-faithful to verification.ts's requiredLabel wording). */
function configBlocks(slaMultiplier: number): SlackBlock[] {
  const out: SlackBlock[] = [
    section('*Verification policy*  ·  _nothing closes on a report alone_'),
    context(
      '• *critical / high* → *L3*: photo + location + recipient confirmation + coordinator sign-off\n' +
        '• *medium / low* → *L2*: recipient confirmation',
    ),
    section('*SLA clock* — response budget per need type (real-world minutes)'),
  ];
  for (const type of TYPE_ORDER) {
    const row = SLA_MINUTES[type];
    const cells = SEV_ORDER.map((s) => `${s} ${humanMinutes(row[s])}`).join(' · ');
    out.push(context(`*${type}* — ${cells}`));
  }
  if (slaMultiplier !== 1) {
    out.push(
      context(`⏱️ _Demo mode: SLAs run compressed ×${slaMultiplier} so drift fires on camera (real budgets above)._`),
    );
  }
  return out;
}

// --- the board --------------------------------------------------------------

/**
 * Build the App Home operations board (a `home` view) for the given need projections.
 * Pure over `needs` + `opts`. The active filter (opts.filter) narrows the counters, the
 * attention list, and the drift panel; the filter buttons are always derived from the FULL
 * set so the viewer can never filter themselves into a dead end.
 */
export function appHomeView(needs: ProjectedNeed[], opts: HomeViewOptions = {}): SlackView {
  const now = opts.now ?? Date.now();
  const filter = opts.filter ?? null;
  const slaMultiplier = opts.slaMultiplier ?? 1;
  const label: LabelFn = (n) => opts.publicIdOf?.(n.need_id) ?? `#${n.need_id.slice(0, 6)}`;

  const active = applyHomeFilter(needs, filter);
  const stats = homeStats(active);

  const blocks: SlackBlock[] = [header('Relay · operations board')];
  // Honest AI-DEGRADED banner (Moonshot #1): when the LLM is unplugged, say so — extraction is
  // heuristic-only and more reports honestly route to NEEDS_REVIEW.
  if (opts.degraded) {
    blocks.push(
      section(
        '🔌 *AI DEGRADED* — extraction is heuristic-only (no LLM); ambiguous reports honestly route to NEEDS_REVIEW.',
      ),
    );
  }
  blocks.push(
    context(
      `As of ${asOfLabel(now)}  ·  ${filterLabel(filter)}${filter ? ` (${active.length} of ${needs.length})` : ''}`,
    ),
    divider,
  );

  // 1) LIVE COUNTERS + verified-today.
  if (active.length === 0) {
    blocks.push(
      section(
        filter
          ? '_No needs match this filter._'
          : '_No needs yet. As reports arrive in #relay-intake, they surface here._',
      ),
    );
  } else {
    const verified = verifiedTodayCount(active, now);
    blocks.push(
      section(
        `*${active.length}* need${active.length === 1 ? '' : 's'} tracked  ·  ✅ *${verified}* verified in the last 24h`,
      ),
    );
    const populated = STATUS_ORDER.filter((s) => stats.byStatus[s] > 0);
    if (populated.length > 0) {
      blocks.push(fields(populated.map((s) => `${STATUS_EMOJI[s]} *${s}:* ${stats.byStatus[s]}`)));
    }
  }

  // 2) NEEDS YOUR ATTENTION.
  blocks.push(divider, section('*Needs your attention*'));
  const attn = attentionNeeds(active, ATTENTION_LIMIT);
  if (attn.length === 0) {
    blocks.push(context('_Nothing waiting on a human right now._'));
  } else {
    blocks.push(...attentionBlocks(attn, label));
  }

  // 3) DRIFTING OBLIGATIONS.
  blocks.push(divider, section('*Drifting obligations*'));
  blocks.push(...driftBlocks(active, now, label));

  // 4) FILTERS (from the full set, so every option stays reachable).
  const fb = filterBlocks(needs, filter);
  if (fb.length > 0) blocks.push(divider, ...fb);

  // 5) CONFIG PANEL.
  blocks.push(divider, ...configBlocks(slaMultiplier));

  // 6) The transparency note (§11.3) stays at the bottom.
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

import { isEvent, type NeedEvent } from '../ledger/events';
import type { ActorType, EvidenceKind } from '../ledger/types';
import { actionId, actions, context, divider, escapeMrkdwn, header, type SlackBlock, section } from './primitives';
import { EVIDENCE_KIND_LABEL } from './verification';

// Click-to-audit for the donor report (Moonshot #6). PURE builders — no store, no Slack
// client, no clock. Every headline figure in `/relay report` carries a 🔍 Audit control; a
// click reveals the redacted, ledger-derived evidence chain behind that number: "the proof
// behind this number".
//
// REDACTION (the ethos — the audit view is READ-ONLY over the ledger, redacted, fictional
// data, never a separate source of truth): buildAuditTrail renders ONLY four facts per event —
// the event TYPE, the evidence KIND (for EvidenceAttached), the timestamp, and the actor TYPE
// (human / agent / system). It NEVER renders a name, phone, address, note/reason free-text, the
// actor id, or an evidence file reference. That makes the whole surface PII-free by construction:
// it only ever reads e.type, e.at, e.actor.type, and (for one event kind) e.payload.kind.

/** action_id prefix for a figure's 🔍 Audit button (parsed back by parseActionId). */
export const REPORT_AUDIT_ACTION = 'report_audit';

/** The join char between a figure key and its backing need-id list in a button value. A '~'
 * cannot appear in a figure key (all keys are [a-z_]+) or a UUID, so decode is unambiguous. */
const AUDIT_SEP = '~';
/** Cap the need-ids encoded into one button value so it can never approach Slack's 2000-char
 * value limit (36-char UUIDs → 24 ids ≈ 900 chars, comfortably under). */
const MAX_ENCODED_IDS = 24;

/** Pack a figure key + the need-ids backing it into one opaque button value:
 * `<figureKey>~<id1>,<id2>,…`. Ids are internal need_ids (opaque, non-PII). */
export function encodeFigureAudit(figureKey: string, needIds: string[]): string {
  const ids = needIds.slice(0, MAX_ENCODED_IDS).join(',');
  return `${figureKey}${AUDIT_SEP}${ids}`;
}

/** Recover { figureKey, needIds } from a packed audit button value. Empty / malformed input
 * yields an empty id list (the handler then no-ops). */
export function decodeFigureAudit(value: string): { figureKey: string; needIds: string[] } {
  const i = value.indexOf(AUDIT_SEP);
  if (i < 0) return { figureKey: value, needIds: [] };
  const figureKey = value.slice(0, i);
  const rest = value.slice(i + 1);
  const needIds = rest === '' ? [] : rest.split(',').filter((id) => id.length > 0);
  return { figureKey, needIds };
}

/** A single 🔍 Audit button element for one figure. action_id encodes the figure key (so a
 * regex handler routes it); the value carries the backing need-ids the handler resolves. */
export function auditButtonElement(figureKey: string, needIds: string[], label: string): SlackBlock {
  return {
    type: 'button',
    text: { type: 'plain_text', text: `🔍 Audit · ${label}`, emoji: true },
    action_id: actionId(REPORT_AUDIT_ACTION, figureKey),
    value: encodeFigureAudit(figureKey, needIds),
  };
}

/** An actions row carrying a single figure's audit control (standalone use). */
export function buildFigureAuditControls(figureKey: string, needIds: string[], label: string): SlackBlock {
  return actions([auditButtonElement(figureKey, needIds, label)]);
}

/** The minimal figure shape the audit panel needs — structurally a narrate `Stat` (key/label/
 * value + the need_ids backing it), typed locally so this surface never imports the narrator. */
export interface AuditFigure {
  key: string;
  label: string;
  value: number | string;
  /** need_ids backing this figure (report stats carry these); absent ⇒ no audit control. */
  eventRefs?: string[];
}
export interface AuditStats {
  stats: AuditFigure[];
}

export interface ReportAuditPanelOptions {
  /** Restrict the panel to these figure keys (e.g. the headline grid); default: all with refs. */
  figureKeys?: readonly string[];
}

/**
 * The 🔍 Audit panel appended under a donor report: one audit button per headline figure that
 * has backing need_ids. A click reveals that figure's redacted evidence chain (buildAuditTrail).
 * Figures with no eventRefs (nothing to prove) get no button.
 */
export function buildReportAuditPanel(stats: AuditStats, opts: ReportAuditPanelOptions = {}): SlackBlock[] {
  const allow = opts.figureKeys !== undefined ? new Set(opts.figureKeys) : null;
  const elements: SlackBlock[] = [];
  for (const s of stats.stats) {
    if (allow !== null && !allow.has(s.key)) continue;
    const refs = s.eventRefs ?? [];
    if (refs.length === 0) continue;
    // Slack caps an actions block at 5 buttons per row / 25 elements; the headline grid is 6.
    if (elements.length >= 5) break;
    elements.push(auditButtonElement(s.key, refs, s.label));
  }
  if (elements.length === 0) return [];
  return [
    context('🔍 *Audit any figure* — the proof behind each number, redacted, straight from the append-only ledger.'),
    actions(elements),
  ];
}

/** Friendly, TYPE-ONLY actor label — reveals the actor's role class, never an identity. */
const ACTOR_LABEL: Record<ActorType, string> = {
  human: 'a human actor',
  agent: 'an automated agent',
  system: 'the system',
};

/** Icon + label per event type. Labels are static UI copy — no ledger content is interpolated. */
const EVENT_META: Record<string, { icon: string; label: string }> = {
  NeedCreated: { icon: '📩', label: 'Need created' },
  ExtractionCompleted: { icon: '🧠', label: 'Classified (type · severity · location)' },
  DuplicateProposed: { icon: '🔁', label: 'Possible duplicate detected' },
  DuplicateConfirmed: { icon: '🔗', label: 'Merged as a duplicate' },
  TriageConfirmed: { icon: '✅', label: 'Triage confirmed' },
  PledgeProposed: { icon: '🤖', label: 'Agent pledge proposed' },
  MatchSuggested: { icon: '🎯', label: 'Volunteers suggested' },
  Claimed: { icon: '🙋', label: 'Claimed by a volunteer' },
  Assigned: { icon: '📌', label: 'Assigned to a volunteer' },
  Nudged: { icon: '⏰', label: 'SLA nudge fired' },
  ClaimReleased: { icon: '↩️', label: 'Claim released' },
  Reassigned: { icon: '🔄', label: 'Reassigned to a new volunteer' },
  EnRouteReported: { icon: '🚚', label: 'Volunteer en route' },
  EvidenceAttached: { icon: '📎', label: 'Evidence attached' },
  RecipientConfirmed: { icon: '🤝', label: 'Recipient confirmed receipt' },
  CoordinatorSignedOff: { icon: '🖊️', label: 'Coordinator signed off' },
  Verified: { icon: '✔️', label: 'Verified on evidence' },
  Closed: { icon: '🏁', label: 'Closed' },
  Reopened: { icon: '♻️', label: 'Reopened' },
  Expired: { icon: '⌛', label: 'Expired' },
  Cancelled: { icon: '🚫', label: 'Cancelled' },
  CommentAdded: { icon: '💬', label: 'Note recorded' },
};

/** A friendly UTC timestamp (second precision) from an ISO string. */
const auditTime = (iso: string): string => `${iso.slice(0, 19).replace('T', ' ')} UTC`;

/** One redacted line for an event: `✓ <icon> *<label>* · <time> · by <actor type>`. For an
 * EvidenceAttached the (allowed) evidence KIND is appended; nothing else is ever read. */
function auditLine(e: NeedEvent): string {
  const meta = EVENT_META[e.type] ?? { icon: '•', label: e.type };
  const kind = isEvent(e, 'EvidenceAttached') ? ` — ${EVIDENCE_KIND_LABEL[e.payload.kind as EvidenceKind]}` : '';
  const by = ACTOR_LABEL[e.actor.type];
  return `✓ ${meta.icon} *${escapeMrkdwn(meta.label)}${kind}* · ${auditTime(e.at)} · by ${by}`;
}

/** Split an array into fixed-size chunks (so many lifecycle lines stay under Slack block limits). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AuditTrailOptions {
  /** Cap the number of lifecycle rows rendered (defaults to the full log). */
  limit?: number;
}

/**
 * The redacted evidence chain behind ONE need — the "proof behind this number". Heading (public
 * id) → read-only disclaimer → an engine-derived verification badge → the ordered lifecycle
 * events, each redacted to type / evidence-kind / time / actor-type only. Pure over its inputs
 * and PII-free by construction (see the module header). `events` are expected in ledger order.
 */
export function buildAuditTrail(publicId: string, events: NeedEvent[], opts: AuditTrailOptions = {}): SlackBlock[] {
  const rows = opts.limit !== undefined ? events.slice(0, Math.max(0, opts.limit)) : events;
  const verified = events.some((e) => isEvent(e, 'Verified'));
  const closed = events.some((e) => isEvent(e, 'Closed'));
  const badge = closed
    ? '✅ Verified on evidence · closed'
    : verified
      ? '✅ Verified on evidence'
      : '⏳ In progress — not yet verified';

  const blocks: SlackBlock[] = [
    header(`🔍 Audit · ${publicId}`),
    context(
      'Read-only view over the append-only ledger. Shows event type, evidence kind, time and actor ' +
        'role only — never a name, contact, or free-text note.',
    ),
    section(`*Verification:* ${badge}`),
    divider,
  ];
  const lines = rows.map(auditLine);
  if (lines.length === 0) {
    blocks.push(context('_No ledger events recorded for this need._'));
  } else {
    for (const group of chunk(lines, 8)) blocks.push(section(group.join('\n')));
  }
  blocks.push(context('Redacted evidence chain · fictional data · every figure traces to a ledger event.'));
  return blocks;
}

import { z } from 'zod';
import { GuardViolation } from './store/errors';
import type { Actor, ConfidenceStatus, EvidenceKind, NeedSource, NeedType, Severity } from './types';

// The append-only event taxonomy (BUILD-DOC §6.3). Event *bodies* are a
// discriminated union on `type`; the durable event = envelope + body. Payloads
// carry only derived, structured fields and Slack object IDs / permalinks —
// NEVER raw message text, quotations, prompts, or model output (zero-copy,
// invariant #5, enforced by assertNoRawContent below).
//
// The LLM (and every adapter) proposes a typed Command; decide() stamps the
// envelope and lets the deterministic engine decide the transition.

export const EVENT_TYPES = [
  'NeedCreated',
  'ExtractionCompleted',
  'DuplicateProposed',
  'DuplicateConfirmed',
  'TriageConfirmed',
  'PledgeProposed',
  'MatchSuggested',
  'Claimed',
  'Assigned',
  'Nudged',
  'ClaimReleased',
  'Reassigned',
  'EnRouteReported',
  'EvidenceAttached',
  'RecipientConfirmed',
  'CoordinatorSignedOff',
  'Verified',
  'Closed',
  'Reopened',
  'Expired',
  'Cancelled',
  'CommentAdded',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

const NEED_TYPES = ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other'] as const;
const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const EVIDENCE_KINDS = ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff'] as const;
const CONFIDENCE_STATUSES = ['stated', 'inferred', 'unknown'] as const;

// --- Typed event bodies ------------------------------------------------------

export interface NeedCreatedPayload {
  source: NeedSource;
  is_demo?: boolean;
}
export interface ExtractionCompletedPayload {
  need_type: NeedType;
  severity: Severity;
  locality_id?: number | null;
  location_text?: string | null;
  people_count?: number | null;
  languages?: string[];
  confidence?: Record<string, ConfidenceStatus>;
  /** Route to NEEDS_REVIEW (human) instead of TRIAGED when extraction can't be trusted. */
  needs_review?: boolean;
}
export interface DuplicateProposedPayload {
  other_need_id: string;
  score: number;
  reason?: string;
}
export interface DuplicateConfirmedPayload {
  merged_into: string;
}
export interface MatchSuggestedPayload {
  candidates: Array<{ volunteer_id: string; score: number }>;
}
/**
 * An external AGENT (via the MCP write tool pledge_support, Moonshot #2) proposes to fulfil a
 * need. This is a PROPOSAL, never a commitment — decide() applies it from OPEN/MATCH_SUGGESTED
 * as a non-gated agent event, moving the need to MATCH_SUGGESTED (still awaiting a human). A
 * coordinator then confirms via the human-gated Assigned, after which the obligation is tracked
 * with the SAME SLA/drift/evidence machinery as any human promise. `volunteer_id` is the agent
 * volunteer the confirm will assign; `pledged_by` is the agent/org display name (never PII).
 */
export interface PledgeProposedPayload {
  volunteer_id: string;
  pledged_by: string;
  note?: string;
}
export interface AssignmentPayload {
  volunteer_id: string;
  obligation_id?: string;
  sla_due_at?: string | null;
}
export interface ReassignedPayload {
  to_volunteer_id: string;
  from_volunteer_id?: string;
  obligation_id?: string;
  sla_due_at?: string | null;
}
export interface EvidenceAttachedPayload {
  kind: EvidenceKind;
  evidence_id?: string;
  meta?: Record<string, unknown>;
}

export type EventBody =
  | { type: 'NeedCreated'; payload: NeedCreatedPayload }
  | { type: 'ExtractionCompleted'; payload: ExtractionCompletedPayload }
  | { type: 'DuplicateProposed'; payload: DuplicateProposedPayload }
  | { type: 'DuplicateConfirmed'; payload: DuplicateConfirmedPayload }
  | { type: 'TriageConfirmed'; payload: { note?: string } }
  | { type: 'PledgeProposed'; payload: PledgeProposedPayload }
  | { type: 'MatchSuggested'; payload: MatchSuggestedPayload }
  | { type: 'Claimed'; payload: AssignmentPayload }
  | { type: 'Assigned'; payload: AssignmentPayload }
  | { type: 'Nudged'; payload: { kind?: string; obligation_id?: string } }
  | { type: 'ClaimReleased'; payload: { volunteer_id?: string; reason?: string } }
  | { type: 'Reassigned'; payload: ReassignedPayload }
  | { type: 'EnRouteReported'; payload: { eta_minutes?: number | null } }
  | { type: 'EvidenceAttached'; payload: EvidenceAttachedPayload }
  | { type: 'RecipientConfirmed'; payload: { confirmed_by?: 'recipient' | 'coordinator_substitute'; reason?: string } }
  | { type: 'CoordinatorSignedOff'; payload: { note?: string } }
  | { type: 'Verified'; payload: { note?: string } }
  | { type: 'Closed'; payload: { note?: string } }
  | { type: 'Reopened'; payload: { reason: string } }
  | { type: 'Expired'; payload: { reason?: string } }
  | { type: 'Cancelled'; payload: { reason: string } }
  | { type: 'CommentAdded'; payload: { ref?: string } };

/** What an adapter / the LLM proposes; decide() turns it into a durable NeedEvent. */
export type Command = EventBody;

/** Provenance envelope stamped by decide() (BUILD-DOC §6.3). */
export interface NeedEventEnvelope {
  event_id: string;
  need_id: string;
  at: string; // ISO timestamp
  actor: Actor;
  idempotency_key: string;
}

export type NeedEvent = NeedEventEnvelope & EventBody;

/** Narrow an event to a specific body type. */
export function isEvent<T extends EventType>(e: NeedEvent, type: T): e is NeedEvent & { type: T } {
  return e.type === type;
}

// --- Zod schemas (one per event body) ---------------------------------------

export const actorSchema = z.object({
  type: z.enum(['human', 'agent', 'system']),
  id: z.string().min(1),
});

const sourceSchema = z.object({
  permalink: z.string().optional(),
  channel: z.string().optional(),
  ts: z.string().optional(),
  team_id: z.string().optional(),
});

const confidenceSchema = z.record(z.string(), z.enum(CONFIDENCE_STATUSES));

/** Per-event payload validators (invariant #3: Zod at every boundary). */
export const payloadSchemas = {
  NeedCreated: z.object({ source: sourceSchema, is_demo: z.boolean().optional() }),
  ExtractionCompleted: z.object({
    need_type: z.enum(NEED_TYPES),
    severity: z.enum(SEVERITIES),
    locality_id: z.number().int().nullable().optional(),
    location_text: z.string().nullable().optional(),
    people_count: z.number().int().nullable().optional(),
    languages: z.array(z.string()).optional(),
    confidence: confidenceSchema.optional(),
    needs_review: z.boolean().optional(),
  }),
  DuplicateProposed: z.object({
    other_need_id: z.string().min(1),
    score: z.number(),
    reason: z.string().optional(),
  }),
  DuplicateConfirmed: z.object({ merged_into: z.string().min(1) }),
  TriageConfirmed: z.object({ note: z.string().optional() }),
  // pledged_by / note are capped so the zero-copy guard (short, single-line derived fields only)
  // can never be tripped by an agent pasting a raw body into the pledge.
  PledgeProposed: z.object({
    volunteer_id: z.string().min(1),
    pledged_by: z.string().min(1).max(120),
    note: z.string().max(280).optional(),
  }),
  MatchSuggested: z.object({
    candidates: z.array(z.object({ volunteer_id: z.string().min(1), score: z.number() })),
  }),
  Claimed: z.object({
    volunteer_id: z.string().min(1),
    obligation_id: z.string().optional(),
    sla_due_at: z.string().nullable().optional(),
  }),
  Assigned: z.object({
    volunteer_id: z.string().min(1),
    obligation_id: z.string().optional(),
    sla_due_at: z.string().nullable().optional(),
  }),
  Nudged: z.object({ kind: z.string().optional(), obligation_id: z.string().optional() }),
  ClaimReleased: z.object({ volunteer_id: z.string().optional(), reason: z.string().optional() }),
  Reassigned: z.object({
    to_volunteer_id: z.string().min(1),
    from_volunteer_id: z.string().optional(),
    obligation_id: z.string().optional(),
    sla_due_at: z.string().nullable().optional(),
  }),
  EnRouteReported: z.object({ eta_minutes: z.number().nullable().optional() }),
  EvidenceAttached: z.object({
    kind: z.enum(EVIDENCE_KINDS),
    evidence_id: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  RecipientConfirmed: z.object({
    confirmed_by: z.enum(['recipient', 'coordinator_substitute']).optional(),
    reason: z.string().optional(),
  }),
  CoordinatorSignedOff: z.object({ note: z.string().optional() }),
  Verified: z.object({ note: z.string().optional() }),
  Closed: z.object({ note: z.string().optional() }),
  Reopened: z.object({ reason: z.string().min(1) }),
  Expired: z.object({ reason: z.string().optional() }),
  Cancelled: z.object({ reason: z.string().min(1) }),
  CommentAdded: z.object({ ref: z.string().optional() }),
} satisfies Record<EventType, z.ZodType>;

export type CommandValidation = { ok: true; command: Command } | { ok: false; message: string };

/** Validate a proposed command's type + payload. Structural boundary check only —
 * legality/authority is the engine's job (decide + canApply). */
export function validateCommand(input: unknown): CommandValidation {
  if (typeof input !== 'object' || input === null || !('type' in input)) {
    return { ok: false, message: 'command must be an object with a `type`' };
  }
  const type = (input as { type: unknown }).type;
  if (typeof type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, message: `unknown event type: ${String(type)}` };
  }
  const schema = payloadSchemas[type as EventType];
  const payload = (input as { payload?: unknown }).payload ?? {};
  const res = schema.safeParse(payload);
  if (!res.success) {
    return { ok: false, message: `${type} payload invalid: ${res.error.issues.map((i) => i.message).join('; ')}` };
  }
  return { ok: true, command: { type, payload: res.data } as Command };
}

// --- Zero-copy guard (invariant #5) -----------------------------------------
// The log persists derived, human-confirmed structured fields + Slack object IDs
// / permalinks. It must NOT persist raw Slack message bodies, quotations, RTS
// results, prompts, or model responses. This guard scans an event by field name
// and by value shape and rejects it before it is appended.

const FORBIDDEN_KEYS = [
  'message_text',
  'message_body',
  'body',
  'text_body',
  'raw',
  'raw_text',
  'transcript',
  'quote',
  'quotation',
  'prompt',
  'completion',
  'model_response',
  'rts_result',
  'retrieved_text',
  'blocks',
];

/** A string this long is almost certainly a pasted raw body, not a derived field. */
const MAX_VALUE_LEN = 1000;
/** ALL Unicode line terminators (LF, CR, LS, PS, NEL, VT, FF). A line break of any
 * kind in a persisted field is a strong signal of a pasted raw body. Checked by
 * char code (not a regex) to keep the control characters out of the source. */
const LINE_BREAK_CODES: ReadonlySet<number> = new Set([0x0a, 0x0d, 0x2028, 0x2029, 0x0085, 0x000b, 0x000c]);

function hasLineBreak(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (LINE_BREAK_CODES.has(s.charCodeAt(i))) return true;
  }
  return false;
}

function scan(value: unknown, path: string, hits: string[]): void {
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE_LEN) hits.push(`${path} (oversized ${value.length} chars)`);
    if (hasLineBreak(value)) hits.push(`${path} (line break in persisted field)`);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    const arr = value as unknown[];
    for (let i = 0; i < arr.length; i++) scan(arr[i], `${path}[${i}]`, hits);
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.includes(key.toLowerCase())) hits.push(`${path}.${key}`);
    scan(v, `${path}.${key}`, hits);
  }
}

/** Returns the list of forbidden field paths / suspicious values (empty == clean). */
export function findRawContent(event: NeedEvent): string[] {
  const hits: string[] = [];
  scan(event, event.type, hits);
  return hits;
}

/** Throws GuardViolation if the event would persist raw content. */
export function assertNoRawContent(event: NeedEvent): void {
  const hits = findRawContent(event);
  if (hits.length > 0) {
    throw new GuardViolation(`zero-copy violation: raw content present at ${hits.join(', ')}`, 'RAW_CONTENT_PERSISTED');
  }
}

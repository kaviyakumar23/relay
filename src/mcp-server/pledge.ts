import type { Command } from '../ledger/events';
import { needEventKey } from '../ledger/idempotency';
import type { DispatchContext, DispatchResult } from '../ledger/needService';
import type { NeedState, ProjectedNeed } from '../ledger/types';
import type { Volunteer } from '../match/volunteerStore';
import type { PledgeSupportArgs, ToolResult } from './tools';

// Moonshot #2 — "Relay holds AI agents accountable too." The ledger-facing logic behind the ONE
// write tool on Relay's otherwise read-only MCP server. An external agent (Claude Desktop; "a food
// bank's agent" in the story) calls pledge_support to pledge to fulfil a need. Crucially this is a
// PROPOSAL, never an auto-commit:
//
//   1. It only functions when writes are enabled (opt-in) — else it returns a clear, non-throwing
//      "writes disabled" result.
//   2. It records the pledge as an AGENT-actor PledgeProposed event (registering an is_agent
//      volunteer for the agent/org if needed). PledgeProposed is NOT a human gate, so the agent may
//      propose — but the need only reaches MATCH_SUGGESTED, never CLAIMED. The need is NOT assigned.
//   3. A human coordinator confirms via the EXISTING human-gated Assign flow → Assigned → CLAIMED.
//      From there the obligation drifts / is chased / is evidence-gated EXACTLY like a human's — the
//      engine's human gate makes it impossible for the agent to skip step 3.
//
// Pure + injectable over a narrow read/write port + a volunteer port, so it is unit-testable by
// direct call with an in-memory NeedService + InMemoryVolunteerStore and zero env. NO beneficiary
// PII ever appears in a result (as with the read tools) — a pledge result echoes only the need's
// public id and the agent's OWN name, never location/contact.

/** The states a need may be pledged from — the pre-claim window where it still awaits a volunteer.
 * Mirrors PledgeProposed's `from` in the state machine so the tool's check and the engine agree. */
const PLEDGEABLE_STATES: ReadonlySet<NeedState> = new Set<NeedState>(['OPEN', 'MATCH_SUGGESTED']);

/** The dispatch seam (NeedService.dispatch), narrowed so the tool never depends on a concrete store. */
export type PledgeDispatch = (needId: string, command: Command, ctx: DispatchContext) => Promise<DispatchResult>;

/** The slice of the volunteer registry the pledge needs: look up + register the agent volunteer. */
export interface PledgeVolunteerPort {
  getBySlackUser(slackUserId: string): Promise<Volunteer | null>;
  upsert(v: Volunteer): Promise<void>;
}

export interface PledgeDeps {
  /** Live projections (to resolve the need + read its state). */
  listNeeds(now?: number): Promise<ProjectedNeed[]>;
  /** Resolve an internal need id → its public id (e.g. N-0007). */
  getPublicId(needId: string): Promise<string | null>;
  /** Append the PledgeProposed event. */
  dispatch: PledgeDispatch;
  /** Register / look up the agent volunteer. */
  volunteers: PledgeVolunteerPort;
  /** The opt-in flag (config.mcpWritesEnabled). When false the tool is inert. */
  enabled: boolean;
  /** Reference clock. Defaults to Date.now(). */
  now?: () => number;
  /** Flag the registered agent volunteer as demo data (so demo reset can purge it). */
  isDemo?: boolean;
}

// --- Tool result helpers (match the shape used by the read tools in tools.ts) -----

const jsonResult = (data: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** A stable, id-safe slug for the agent/org name (never built from message content). */
function slug(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.length > 0 ? s : 'agent';
}

/** The roster id for an agent pledger. `agent:` prefix keeps it clearly distinct from a Slack user id. */
export const agentVolunteerId = (pledgedBy: string): string => `agent:${slug(pledgedBy)}`;

/** A short, single-line, length-capped note — belt-and-suspenders against the zero-copy guard
 * (the Zod schema also caps it). Returns undefined when there is nothing meaningful to keep. */
function sanitizeNote(note: string | undefined): string | undefined {
  if (note === undefined) return undefined;
  const cleaned = note.replace(/\s+/g, ' ').trim().slice(0, 280);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Build the pledge_support handler over its deps. Returns a plain async function — call it directly
 * in tests, or register it on the McpServer (see server.ts). It NEVER throws: every failure path
 * (writes disabled, unknown need, un-pledgeable state, engine rejection) returns a clear result the
 * agent can branch on.
 */
export function createPledgeTool(deps: PledgeDeps): (args: PledgeSupportArgs) => Promise<ToolResult> {
  const nowOf = deps.now ?? ((): number => Date.now());

  return async function pledgeSupport(args: PledgeSupportArgs): Promise<ToolResult> {
    // (1) Opt-in gate. A write tool is disabled by default; say so plainly, change nothing.
    if (!deps.enabled) {
      return jsonResult({
        status: 'writes_disabled',
        message:
          'Relay MCP write tools are disabled on this server. An operator must set ' +
          'RELAY_MCP_WRITES_ENABLED to accept agent pledges. No pledge was filed.',
      });
    }

    const pledgedBy = args.pledged_by.trim();
    if (pledgedBy === '') {
      return jsonResult(
        { status: 'invalid', message: 'pledged_by (the agent or organisation name) is required.' },
        true,
      );
    }

    // (2) Resolve the need by public id from the live projections.
    const now = nowOf();
    const needs = await deps.listNeeds(now);
    let target: { need: ProjectedNeed; publicId: string } | null = null;
    for (const need of needs) {
      const publicId = (await deps.getPublicId(need.need_id)) ?? need.need_id;
      if (publicId === args.need_public_id) {
        target = { need, publicId };
        break;
      }
    }
    if (target === null) {
      return jsonResult({ error: 'not_found', message: `no need with public_id ${args.need_public_id}` }, true);
    }

    // (3) Only OPEN / awaiting-a-match needs are pledgeable — a helpful message otherwise (no throw).
    if (!PLEDGEABLE_STATES.has(target.need.state)) {
      return jsonResult({
        status: 'not_pledgeable',
        need_public_id: target.publicId,
        state: target.need.state,
        message:
          `${target.publicId} is ${target.need.state} — a pledge can only be filed while a need is ` +
          'OPEN or awaiting a match (MATCH_SUGGESTED). No pledge was filed.',
      });
    }

    // (4) Register the agent volunteer if we have not seen it before. This is the roster identity a
    // coordinator's confirm (Assigned) will point at; it carries NO PII (the agent's own org name).
    const volunteerId = agentVolunteerId(pledgedBy);
    const existing = await deps.volunteers.getBySlackUser(volunteerId);
    if (existing === null) {
      await deps.volunteers.upsert({
        slack_user_id: volunteerId,
        display_name: pledgedBy,
        skills: [],
        languages: [],
        home_locality: null,
        radius_km: 0,
        capacity_per_day: 99,
        availability: {},
        active_load: 0,
        is_demo: deps.isDemo ?? false,
        is_agent: true,
      });
    }

    // (5) Record the pledge as an AGENT-actor proposal. Deterministic idempotency key: the same
    // agent pledging the same need twice collapses to one event (returns "already on file").
    const note = sanitizeNote(args.note);
    const command: Command = {
      type: 'PledgeProposed',
      payload: { volunteer_id: volunteerId, pledged_by: pledgedBy, ...(note !== undefined ? { note } : {}) },
    };
    const ctx: DispatchContext = {
      actor: { type: 'agent', id: volunteerId },
      at: new Date(now).toISOString(),
      idempotencyKey: needEventKey(target.need.need_id, 'PledgeProposed', slug(pledgedBy)),
      now,
    };

    let res: DispatchResult;
    try {
      res = await deps.dispatch(target.need.need_id, command, ctx);
    } catch (err) {
      // The tool must never throw — surface the engine error as a clean result.
      return jsonResult(
        { status: 'error', need_public_id: target.publicId, message: `pledge could not be filed: ${String(err)}` },
        true,
      );
    }

    if (res.status === 'suppressed') {
      return jsonResult({
        status: 'pledge_filed',
        need_public_id: target.publicId,
        pledged_by: pledgedBy,
        requires_confirmation: true,
        message:
          `This pledge for ${target.publicId} by ${pledgedBy} was already on file (idempotent). ` +
          'A Relay coordinator must still confirm it before it becomes a tracked commitment.',
      });
    }
    if (res.status !== 'applied') {
      return jsonResult(
        {
          status: 'rejected',
          need_public_id: target.publicId,
          message: `pledge could not be filed (${res.code ?? res.status}). No pledge was recorded.`,
        },
        true,
      );
    }

    return jsonResult({
      status: 'pledge_filed',
      need_public_id: target.publicId,
      pledged_by: pledgedBy,
      requires_confirmation: true,
      message:
        `Pledge filed for ${target.publicId} by ${pledgedBy}. A Relay coordinator must CONFIRM it ` +
        'before it becomes a commitment — Relay never auto-assigns an agent pledge. Once confirmed, ' +
        'it is tracked with the same SLA, drift detection and evidence-gated verification as any ' +
        'human volunteer promise.',
    });
  };
}

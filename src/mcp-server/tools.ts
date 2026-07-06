import { z } from 'zod';
import type { NeedState, NeedType, ProjectedNeed, Severity } from '../ledger/types';
import { computeSitrepStats, type SitrepStats } from '../narrate/aggregate';
import { verificationStatus } from '../surfaces/verification';

// Pure, transport-agnostic implementations of Relay's read-only MCP tools (P1 — the MCP
// qualifying technology). An external agent (Claude Desktop, an Agentforce agent) queries
// LIVE relief operations through these; nothing here can mutate the ledger.
//
// PRIVACY (CLAUDE.md invariants 5 & 9): every value returned here is derived from a
// ProjectedNeed, which is PII-FREE BY CONSTRUCTION — beneficiary contact lives only in the
// encrypted contact_vault and never reaches a projection. We surface counts, states,
// evidence *kinds*, and Slack permalinks only. We deliberately do NOT expose the assigned
// volunteer's id (a person identifier) — get_need returns `is_assigned` instead. Handlers
// are exported free of any transport so they are unit-testable by direct call.

// --- Domain enums (runtime lists, checked against the domain unions) ---------

const NEED_STATES = [
  'NEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'CLAIMED',
  'IN_PROGRESS',
  'DELIVERED_UNVERIFIED',
  'VERIFIED',
  'CLOSED',
  'NEEDS_REVIEW',
  'DUPLICATE',
  'EXPIRED',
  'REOPENED',
  'CANCELLED',
] as const satisfies readonly NeedState[];

const NEED_TYPES = [
  'medical',
  'rescue',
  'food',
  'water',
  'shelter',
  'transport',
  'other',
] as const satisfies readonly NeedType[];

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly Severity[];

/** Pre-claim states where a need is still awaiting a volunteer (mirrors the sitrep's
 * "open" bucket in narrate/aggregate so `only_open` and get_sitrep.open agree). */
const OPEN_STATES: ReadonlySet<NeedState> = new Set<NeedState>([
  'NEW',
  'TRIAGED',
  'OPEN',
  'MATCH_SUGGESTED',
  'REOPENED',
]);

// --- Input schemas (Zod at the boundary; also the tools/list JSON schema) -----

export const SearchNeedsInput = z.object({
  status: z
    .enum(NEED_STATES)
    .optional()
    .describe('Filter to needs currently in this ledger state (e.g. OPEN, IN_PROGRESS, VERIFIED).'),
  type: z
    .enum(NEED_TYPES)
    .optional()
    .describe('Filter by need type (medical, rescue, food, water, shelter, transport, other).'),
  severity: z.enum(SEVERITIES).optional().describe('Filter by severity (critical, high, medium, low).'),
  locality: z.string().min(1).optional().describe("Case-insensitive substring match against the need's location text."),
  only_open: z.boolean().optional().describe('Return only needs still awaiting a volunteer (pre-claim states).'),
  limit: z.number().int().positive().max(200).optional().describe('Maximum rows to return (default 50, max 200).'),
});
export type SearchNeedsArgs = z.infer<typeof SearchNeedsInput>;

export const GetNeedInput = z.object({
  public_id: z.string().min(1).describe('The human-facing public need id, e.g. "N-0007".'),
});
export type GetNeedArgs = z.infer<typeof GetNeedInput>;

export const GetSitrepInput = z.object({});
export type GetSitrepArgs = z.infer<typeof GetSitrepInput>;

// --- Dependencies -----------------------------------------------------------

/** The narrow read-only slice of the ledger the tools need. NeedService satisfies
 * `listNeeds`; `getPublicId` comes from the EventStore. The entrypoint composes both
 * into one object (see stdio.ts) so tools.ts never depends on a concrete store. */
export interface NeedReadPort {
  listNeeds(now?: number): Promise<ProjectedNeed[]>;
  getPublicId(needId: string): Promise<string | null>;
}

/** Computes the live sitrep stats. Defaults to computeSitrepStats over the read port. */
export type SitrepFn = (now: number) => SitrepStats | Promise<SitrepStats>;

export interface RelayToolDeps {
  service: NeedReadPort;
  /** Override the sitrep computation (defaults to computeSitrepStats over `service`). */
  sitrep?: SitrepFn;
  /** Reference clock for drift flags / "today". Defaults to Date.now(). */
  now?: () => number;
}

// --- Tool result shape (a subset of the MCP CallToolResult) ------------------

// A `type` alias (not an interface) so it carries the implicit string index signature the
// SDK's CallToolResult requires — an interface would not be assignable to it.
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

const jsonResult = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
});

/** A clean, non-throwing "not found" result (isError so the agent can branch on it). */
const notFoundResult = (message: string): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: 'not_found', message }) }],
  isError: true,
});

// --- Projections → PII-free view models -------------------------------------

interface CompactNeed {
  public_id: string;
  status: NeedState;
  type: NeedType;
  severity: Severity;
  location_text: string | null;
  people_count: number | null;
  is_drifting: boolean;
}

const toCompact = (publicId: string, need: ProjectedNeed): CompactNeed => ({
  public_id: publicId,
  status: need.state,
  type: need.type,
  severity: need.severity,
  location_text: need.location_text,
  people_count: need.people_count,
  is_drifting: need.flags.is_drifting,
});

const toDetail = (publicId: string, need: ProjectedNeed): Record<string, unknown> => {
  const v = verificationStatus(need);
  return {
    public_id: publicId,
    status: need.state,
    type: need.type,
    severity: need.severity,
    locality_id: need.locality_id,
    location_text: need.location_text,
    people_count: need.people_count,
    languages: need.languages,
    is_assigned: need.assigned_volunteer_id !== null,
    flags: need.flags,
    // Evidence packet: kind + attestation time only (no evidence content, no PII).
    evidence: need.evidence.map((e) => ({ kind: e.kind, at: e.at })),
    verification: {
      level: v.level,
      label: v.label,
      meets_policy: v.meetsPolicy,
      required: v.requiredLabel,
      missing: v.missing,
    },
    sla_due_at: need.sla_due_at,
    // A citation link back to the source thread (permalinks are the approved provenance
    // mechanism, CLAUDE.md #9) — a reference, never message content.
    source_permalink: need.source.permalink ?? null,
    created_at: need.created_at,
    updated_at: need.updated_at,
    state_version: need.state_version,
    history_count: need.history_count,
  };
};

// --- Tool handlers ----------------------------------------------------------

/** Pair every projected need with its human-facing public_id (falls back to the internal
 * id if the store cannot resolve one). Public-id lookup is per-need — fine at demo scale. */
async function needsWithPublicIds(
  service: NeedReadPort,
  now: number,
): Promise<Array<{ publicId: string; need: ProjectedNeed }>> {
  const needs = await service.listNeeds(now);
  const out: Array<{ publicId: string; need: ProjectedNeed }> = [];
  for (const need of needs) {
    const publicId = (await service.getPublicId(need.need_id)) ?? need.need_id;
    out.push({ publicId, need });
  }
  return out;
}

export interface RelayTools {
  search_needs(args: SearchNeedsArgs): Promise<ToolResult>;
  get_need(args: GetNeedArgs): Promise<ToolResult>;
  get_sitrep(args: GetSitrepArgs): Promise<ToolResult>;
}

/** Bind the three read-only tools to their dependencies. Returns plain async functions —
 * call them directly in tests, or register them on an McpServer (see server.ts). */
export function createRelayTools(deps: RelayToolDeps): RelayTools {
  const nowOf = deps.now ?? ((): number => Date.now());
  const sitrepOf: SitrepFn = deps.sitrep ?? (async (now) => computeSitrepStats(await deps.service.listNeeds(now), now));

  return {
    async search_needs(args) {
      const now = nowOf();
      const rows = await needsWithPublicIds(deps.service, now);
      const locality = args.locality?.toLowerCase();
      const matched = rows.filter(({ need }) => {
        if (args.status !== undefined && need.state !== args.status) return false;
        if (args.type !== undefined && need.type !== args.type) return false;
        if (args.severity !== undefined && need.severity !== args.severity) return false;
        if (args.only_open === true && !OPEN_STATES.has(need.state)) return false;
        if (locality !== undefined && !(need.location_text ?? '').toLowerCase().includes(locality)) return false;
        return true;
      });
      const limit = args.limit ?? 50;
      const needs = matched.slice(0, limit).map(({ publicId, need }) => toCompact(publicId, need));
      return jsonResult({ count: needs.length, total_matched: matched.length, needs });
    },

    async get_need(args) {
      const now = nowOf();
      const rows = await needsWithPublicIds(deps.service, now);
      const match = rows.find(({ publicId }) => publicId === args.public_id);
      if (match === undefined) return notFoundResult(`no need with public_id ${args.public_id}`);
      return jsonResult(toDetail(match.publicId, match.need));
    },

    async get_sitrep(_args) {
      const now = nowOf();
      const stats = await sitrepOf(now);
      return jsonResult(stats);
    },
  };
}

// --- Registration metadata (name/title/description + schema) for server.ts ----

export const RELAY_TOOL_INFO = {
  search_needs: {
    name: 'search_needs',
    title: 'Search relief needs',
    description:
      'List live relief needs from the Relay ledger, with optional filters (status, type, severity, locality, only_open, limit). Returns a compact, PII-free summary of each need — never beneficiary contact.',
    inputSchema: SearchNeedsInput,
  },
  get_need: {
    name: 'get_need',
    title: 'Get one need',
    description:
      'Fetch the full projected detail of a single need by its public id (e.g. "N-0007"): status, severity, location, evidence packet (kinds + timestamps) and verification level. PII-free — no beneficiary contact, no volunteer identity.',
    inputSchema: GetNeedInput,
  },
  get_sitrep: {
    name: 'get_sitrep',
    title: 'Operational sitrep',
    description:
      'The live situation report as structured JSON: counts of active / open / critical / drifting / verified needs plus breakdowns by type, severity and status. Numbers only, computed directly from the event ledger.',
    inputSchema: GetSitrepInput,
  },
} as const;

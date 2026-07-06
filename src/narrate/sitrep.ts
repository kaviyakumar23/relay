import type { ProjectedNeed } from '../ledger/types';
import { buildSitrepRequest } from '../llm/prompts/p5-sitrep';
import type { LlmProvider } from '../llm/provider';
import { context, divider, fields, header, type SlackBlock, section } from '../surfaces/primitives';
import { computeSitrepStats, type SitrepStats } from './aggregate';
import { narrateWithIntegrity } from './statTokens';

// /relay sitrep (BUILD-DOC §F6) — the LIVE board snapshot for #relay-hq. This module is the
// live wiring of the pure aggregation + number-integrity engine: it reads the ledger
// projection, computes the ordered headline StatSet, narrates it (LLM when a key is present,
// the deterministic plain-stats template otherwise — the no-LLM path is fully deterministic),
// and lays the result out as Block Kit: a headline stat grid drawn straight from the StatSet,
// then the VALIDATED narrative (whose every digit is a ledger value — a hallucinated number
// can never reach here; statTokens falls back to the template on any stray).
//
// PRIVACY: the ledger is PII-free by construction, so a sitrep carries only counts — the
// narrator never sees beneficiary contact.

/** The narrow slice of NeedService a sitrep needs (structural, so tests pass a fake). */
export interface SitrepService {
  listNeeds(now?: number): Promise<ProjectedNeed[]>;
}

export interface GenerateSitrepArgs {
  service: SitrepService;
  /** Present iff an LLM key is configured; undefined ⇒ the deterministic template path. */
  llm?: LlmProvider;
  /** Reference clock for "today" / drift flags. Defaults to Date.now(). */
  now?: number;
}

export interface SitrepResult {
  blocks: SlackBlock[];
  /** The validated narrative (also the message fallback text). */
  text: string;
  stats: SitrepStats;
  source: 'llm' | 'template';
}

/** The figures promoted into the headline grid, in display order. Every key is always present
 * in a sitrep StatSet (they are emitted unconditionally), so the grid never has a gap. */
const HEADLINE_KEYS: readonly string[] = [
  'total_active',
  'open',
  'open_critical',
  'active_obligations',
  'drifting',
  'at_risk',
  'verified',
  'needs_review',
];

/** A two-column headline grid of the operational figures, straight from the StatSet (not
 * narrated prose — these are ledger values, not subject to the stray-number guard). */
function headlineGrid(stats: SitrepStats): SlackBlock | null {
  const byKey = new Map(stats.stats.map((s) => [s.key, s]));
  const cells: string[] = [];
  for (const key of HEADLINE_KEYS) {
    const s = byKey.get(key);
    if (s !== undefined) cells.push(`*${s.value}* ${s.label}`);
  }
  return cells.length > 0 ? fields(cells) : null;
}

/** Build the sitrep Block Kit: header → headline stat grid → the validated narrative → a
 * provenance footer. Deterministic given the stats + narrative. */
export function buildSitrepBlocks(stats: SitrepStats, narrative: string, now: number): SlackBlock[] {
  const blocks: SlackBlock[] = [header('Relay sitrep — live board')];
  const grid = headlineGrid(stats);
  if (grid !== null) blocks.push(grid);
  blocks.push(divider);
  blocks.push(section(narrative));
  blocks.push(context(`As of ${new Date(now).toISOString()} · every figure drawn directly from the ledger`));
  return blocks;
}

/**
 * Generate the live sitrep from the current ledger projection. Numbers come from
 * computeSitrepStats; the narrative is guaranteed (by narrateWithIntegrity) to contain only
 * those numbers. With no llm the narrative is the deterministic template — so this function is
 * fully deterministic and hermetic in the no-key path.
 */
export async function generateSitrep(args: GenerateSitrepArgs): Promise<SitrepResult> {
  const now = args.now ?? Date.now();
  const needs = await args.service.listNeeds(now);
  const stats = computeSitrepStats(needs, now);
  const narration = await narrateWithIntegrity({
    stats: stats.stats,
    kind: 'sitrep',
    llm: args.llm,
    buildRequest: buildSitrepRequest,
  });
  return {
    blocks: buildSitrepBlocks(stats, narration.text, now),
    text: narration.text,
    stats,
    source: narration.source,
  };
}

import { isEvent, type NeedEvent } from '../ledger/events';
import type { ProjectedNeed } from '../ledger/types';
import { logger } from '../lib/logger';
import { buildReportRequest } from '../llm/prompts/p6-report';
import type { LlmProvider, ParseRequest } from '../llm/provider';
import { context, divider, fields, header, type SlackBlock, section } from '../surfaces/primitives';
import { computeReportStats, type ReportStats, type ReportWindow, type Stat, type StatSet } from './aggregate';
import { type ReportFootnote, type ReportInput, type ReportStat, renderReportMarkdown } from './markdown';
import { assertNoPii, scrubText } from './redaction';
import { type NarrativeSchema, narrateWithIntegrity, plainStatsTemplate, type TokenInfo } from './statTokens';

// /relay report (BUILD-DOC §F7) — the VERIFIED-ONLY donor/impact record. The crown-jewel
// guarantee: every number equals a ledger value AND the artifact carries NO PII. This module
// is the live wiring around the pure pieces:
//   1. computeReportStats over verified-only events → the ordered StatSet (refs = need_ids).
//   2. resolve each need_id ref → its public id (N-xxxx) so citations are reader-facing AND
//      letter-prefixed (statTokens exempts [N-..] refs from the number guard; a raw UUID ref
//      would look like a stray number).
//   3. scrubText the LLM INPUT (defense-in-depth; the input is already PII-free by construction).
//   4. narrateWithIntegrity(kind:'report') — every digit a {{stat:*}} token, guarded against
//      strays; falls back to the deterministic template on any failure.
//   5. assertNoPii(final): if a hard identifier (phone/email) somehow survived, HARD-fall back
//      to the plain template and log — a donor report MUST NEVER emit PII.
//   6. renderReportMarkdown → the downloadable artifact; a final assertNoPii gate + last-resort
//      scrub guarantees the emitted Markdown is clean.

/** The narrow slice of NeedService a report needs (structural, so tests pass a fake). */
export interface ReportService {
  listNeeds(now?: number): Promise<ProjectedNeed[]>;
  getEvents(needId: string): Promise<NeedEvent[]>;
}

/** A reporting window: a human `label` (shown in the artifact) + the optional numeric bounds
 * that actually scope the verified events. */
export interface ReportPeriod {
  label: string;
  sinceMs?: number;
  untilMs?: number;
}

export interface GenerateReportArgs {
  service: ReportService;
  /** Present iff an LLM key is configured; undefined ⇒ the deterministic template path. */
  llm?: LlmProvider;
  period: ReportPeriod;
  now?: number;
  /** Resolve a need_id to its public id (N-0421) for reader-facing citations/footnotes.
   * Defaults to a stable letter-prefixed short id derived from the need_id. */
  resolvePublicId?: (needId: string) => Promise<string>;
}

export interface ReportResult {
  blocks: SlackBlock[];
  markdown: string;
  /** A short plain-text summary (message fallback text). */
  text: string;
  stats: ReportStats;
  source: 'llm' | 'template';
}

const MS_PER_DAY = 86_400_000;
/** Cap refs shown in a Markdown figure row (the full set lives in the footnotes). */
const MAX_ROW_REFS = 6;

/**
 * Parse the optional `/relay report [period]` argument into a window. Unknown / empty ⇒ all
 * time. Kept small and deterministic so the command path stays hermetic.
 */
export function parseReportPeriod(arg: string, now: number): ReportPeriod {
  const key = arg.trim().toLowerCase();
  if (key === '24h' || key === '1d' || key === 'today' || key === 'day') {
    return { label: 'last 24 hours', sinceMs: now - MS_PER_DAY };
  }
  if (key === '7d' || key === 'week') return { label: 'last 7 days', sinceMs: now - 7 * MS_PER_DAY };
  if (key === '30d' || key === 'month') return { label: 'last 30 days', sinceMs: now - 30 * MS_PER_DAY };
  return { label: 'all time' };
}

/** Remap each Stat's `eventRefs` from need_ids to resolved public ids (cached per id). Used for
 * BOTH the narration token list and the Markdown figure rows so citations are consistent. */
async function resolveRefs(stats: StatSet, resolve: (id: string) => Promise<string>): Promise<StatSet> {
  const cache = new Map<string, string>();
  const resolveOne = async (id: string): Promise<string> => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const pub = await resolve(id);
    cache.set(id, pub);
    return pub;
  };
  const out: StatSet = [];
  for (const s of stats) {
    if (s.eventRefs === undefined) {
      out.push(s);
      continue;
    }
    const refs: string[] = [];
    for (const id of s.eventRefs) refs.push(await resolveOne(id));
    out.push({ ...s, eventRefs: refs });
  }
  return out;
}

/** One footnote per verified need: public id → a PII-free description of the backing Verified
 * event + its source permalink. The description is scrubbed as belt-and-suspenders. */
async function buildFootnotes(
  needs: ProjectedNeed[],
  reportStats: ReportStats,
  eventsByNeed: Map<string, NeedEvent[]>,
  resolve: (id: string) => Promise<string>,
): Promise<ReportFootnote[]> {
  const scopedIds = reportStats.stats.find((s) => s.key === 'total_needs')?.eventRefs ?? [];
  const byId = new Map(needs.map((n) => [n.need_id, n]));
  const out: ReportFootnote[] = [];
  const seen = new Set<string>();
  for (const id of scopedIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const need = byId.get(id);
    if (need === undefined) continue;
    const pub = await resolve(id);
    const verified = (eventsByNeed.get(id) ?? []).find((e) => isEvent(e, 'Verified'));
    const when = verified !== undefined ? new Date(Date.parse(verified.at)).toISOString().slice(0, 10) : 'date on file';
    const place = need.location_text ?? 'locality on file';
    const event = scrubText(`Verified ${need.type} delivery · ${place} · ${when}`);
    const permalink = need.source.permalink;
    out.push(permalink !== undefined ? { id: pub, event, permalink } : { id: pub, event });
  }
  return out;
}

/** The figures promoted into the message's headline grid, in display order. */
const REPORT_HEADLINE_KEYS: readonly string[] = [
  'total_needs',
  'verified_deliveries',
  'people_helped',
  'volunteers_engaged',
  'median_response_minutes',
  'evidence_complete_pct',
];

function reportHeadlineGrid(stats: ReportStats): SlackBlock | null {
  const byKey = new Map(stats.stats.map((s) => [s.key, s]));
  const cells: string[] = [];
  for (const key of REPORT_HEADLINE_KEYS) {
    const s = byKey.get(key);
    if (s !== undefined) cells.push(`*${s.value}* ${s.label}`);
  }
  return cells.length > 0 ? fields(cells) : null;
}

function buildReportBlocks(stats: ReportStats, narrative: string, periodLabel: string): SlackBlock[] {
  const blocks: SlackBlock[] = [header('Relay verified-impact report')];
  blocks.push(context(`Period: ${periodLabel} · verified deliveries only`));
  const grid = reportHeadlineGrid(stats);
  if (grid !== null) blocks.push(grid);
  blocks.push(divider);
  blocks.push(section(narrative));
  blocks.push(context('Every figure is tied to a ledger event; see the attached Markdown for per-claim footnotes.'));
  return blocks;
}

/** Wrap the P-6 request builder so the actual LLM INPUT is scrubbed before it leaves the
 * process (defense-in-depth — the token list is already PII-free by construction). */
function scrubbedReportRequest(stats: StatSet, tokens: TokenInfo[]): ParseRequest<typeof NarrativeSchema> {
  const req = buildReportRequest(stats, tokens);
  return { ...req, system: scrubText(req.system), user: scrubText(req.user) };
}

/**
 * Generate the verified-impact report. Verified-only figures, source-linked footnotes, and a
 * hard PII gate on the final artifact. Deterministic (template narrative) with no llm.
 */
export async function generateReport(args: GenerateReportArgs): Promise<ReportResult> {
  const now = args.now ?? Date.now();
  const needs = await args.service.listNeeds(now);
  const eventsByNeed = new Map<string, NeedEvent[]>();
  for (const n of needs) eventsByNeed.set(n.need_id, await args.service.getEvents(n.need_id));

  const window: ReportWindow = {};
  if (args.period.sinceMs !== undefined) window.sinceMs = args.period.sinceMs;
  if (args.period.untilMs !== undefined) window.untilMs = args.period.untilMs;
  const reportStats = computeReportStats(needs, eventsByNeed, window);

  const resolve = args.resolvePublicId ?? (async (id: string) => `N-${id.slice(0, 8)}`);
  const resolvedStats = await resolveRefs(reportStats.stats, resolve);

  const narration = await narrateWithIntegrity({
    stats: resolvedStats,
    kind: 'report',
    llm: args.llm,
    buildRequest: scrubbedReportRequest,
  });

  // The F7 hard gate: a report must NEVER emit PII. If a hard identifier survived the number
  // guard (e.g. a digit-free email the LLM invented), fall back to the deterministic template.
  let narrative = narration.text;
  let source = narration.source;
  const narrativeGate = assertNoPii(narrative);
  if (!narrativeGate.ok) {
    logger.error(
      { surface: 'report', hits: narrativeGate.hits.length },
      'report.narrative.pii_gate_failed — falling back to template',
    );
    narrative = plainStatsTemplate(resolvedStats, 'report');
    source = 'template';
  }

  const footnotes = await buildFootnotes(needs, reportStats, eventsByNeed, resolve);
  const statRows: ReportStat[] = resolvedStats.map((s: Stat) => ({
    label: s.label,
    value: s.value,
    ...(s.eventRefs !== undefined ? { refs: s.eventRefs.slice(0, MAX_ROW_REFS) } : {}),
  }));
  const input: ReportInput = {
    title: 'Relay verified-impact report',
    period: args.period.label,
    narrative,
    stats: statRows,
    footnotes,
  };
  let markdown = renderReportMarkdown(input);

  // Belt-and-suspenders: gate the RENDERED artifact too; last-resort scrub if anything slipped
  // in via a figure/footnote (should never happen — the ledger is PII-free).
  const markdownGate = assertNoPii(markdown);
  if (!markdownGate.ok) {
    logger.error(
      { surface: 'report', hits: markdownGate.hits.length },
      'report.markdown.pii_gate_failed — scrubbing artifact',
    );
    markdown = scrubText(markdown);
  }

  const blocks = buildReportBlocks(reportStats, narrative, args.period.label);
  const text = `Verified-impact report (${args.period.label}): ${reportStats.totalNeeds} needs verified, ${reportStats.peopleHelped} people helped.`;
  return { blocks, markdown, text, stats: reportStats, source };
}

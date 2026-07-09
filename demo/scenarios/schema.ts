import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Scenario schema — the contract for demo/scenarios/*.yaml (BUILD-DOC §12.2).
//
// A scenario is a deterministic, replayable script the injector fires as the
// "Relay Simulator 🧪" identity (CLAUDE.md rule 10). It carries two things:
//   1. `steps`        — the ordered stimulus (messages + volunteer actions).
//   2. `expectations` — capability-tagged assertions the demo driver / smoke
//                       test checks. Each expectation names the capability it
//                       exercises so the driver asserts ONLY what is wired up
//                       today: on Jul 4 only `skeleton` may be live; by Jul 9
//                       every capability is. Unimplemented capabilities are
//                       skipped, never failed. This lets one frozen scenario
//                       grow with the build instead of being rewritten.
//
// Everything here is validated at the boundary (CLAUDE.md: "Zod at every
// boundary … scenario/eval files"). The injector and the lint both go through
// `parseScenario` — there is no other way in.

// --- Steps -----------------------------------------------------------------

/** `en` = English · `ta-en` = transliterated Tamil-English code-mix (§10.3). */
export const languageSchema = z.enum(['en', 'ta-en']);
export type ScenarioLanguage = z.infer<typeof languageSchema>;

// --- SLA overrides (Moonshot #5: same engine, config-only) -----------------
//
// A scenario may carry an optional `sla:` block that overrides the engine's default SLA
// budget table (src/drift/slaConfig.ts DEFAULT_SLA_TABLE) for this disaster. It is a PARTIAL
// table: name only the (type, severity) cells this scenario changes; every omitted cell falls
// back to the default at merge time (mergeSlaTable). This is the ONLY knob a second scenario
// needs to run a different SLA regime on the SAME computeSlaDueAtMs / driftEngine — data, not
// code. `need type`/`severity` mirror src/ledger/types (kept local so this schema stays self-
// contained); budgets are real-world minutes (positive integers). partialRecord (zod v4) is
// what makes the subset legal — a plain z.record over an enum key would demand every cell.

/** Need types the SLA table is keyed by — mirrors src/ledger/types NeedType. */
export const needTypeSchema = z.enum(['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other']);
export type ScenarioNeedType = z.infer<typeof needTypeSchema>;

/** Severities the SLA table is keyed by — mirrors src/ledger/types Severity. */
export const severitySchema = z.enum(['critical', 'high', 'medium', 'low']);
export type ScenarioSeverity = z.infer<typeof severitySchema>;

/** A partial SLA override table: `{ [type]: { [severity]: minutes } }`, any subset of cells.
 * Structurally identical to src/drift/slaConfig.ts SlaOverrides, so `mergeSlaTable(scenario.sla)`
 * type-checks without the demo schema importing engine internals. */
export const slaOverridesSchema = z.partialRecord(
  needTypeSchema,
  z.partialRecord(severitySchema, z.number().int().positive()),
);
export type SlaOverrides = z.infer<typeof slaOverridesSchema>;

/**
 * A raw intake message posted into `#relay-intake`. `id` is the stable ref
 * that expectations and volunteer steps point at (a need is created per
 * message, keyed back to this id). `contact` is the beneficiary phone string
 * exactly as it appears in the text — the deterministic exact-contact dedupe
 * (§F1) links two messages that share one, so duplicates MUST repeat the
 * string verbatim. All contacts are obviously-fictional (`98400 0…`).
 */
export const intakeMessageStep = z.object({
  kind: z.literal('intake_message'),
  id: z.string().min(1),
  persona: z.string().min(1), // display name of the reporter/operator, not the beneficiary
  language: languageSchema,
  text: z.string().min(1),
  delay_ms: z.number().int().nonnegative(), // wait before firing this step
  contact: z.string().min(1).optional(),
});
export type IntakeMessageStep = z.infer<typeof intakeMessageStep>;

/** A volunteer self-claiming a need (§F3). `volunteer_ref` is a seed
 * `slack_user_id` (SEED_Uxx); `need_ref` is an intake message `id`. */
export const volunteerClaimStep = z.object({
  kind: z.literal('volunteer_claim'),
  volunteer_ref: z.string().min(1),
  need_ref: z.string().min(1),
  delay_ms: z.number().int().nonnegative(),
});
export type VolunteerClaimStep = z.infer<typeof volunteerClaimStep>;

/** A volunteer's reply to a drift nudge (§F4). `release` hands the obligation
 * back and drives the hero reassignment; the claim it answers is resolved by
 * `volunteer_ref` (a volunteer holds one obligation in a scenario). */
export const volunteerReplyStep = z.object({
  kind: z.literal('volunteer_reply'),
  volunteer_ref: z.string().min(1),
  reply: z.enum(['on_my_way', 'delayed', 'release']),
  delay_ms: z.number().int().nonnegative(),
});
export type VolunteerReplyStep = z.infer<typeof volunteerReplyStep>;

export const stepSchema = z.discriminatedUnion('kind', [intakeMessageStep, volunteerClaimStep, volunteerReplyStep]);
export type ScenarioStep = z.infer<typeof stepSchema>;

// --- Expectations ----------------------------------------------------------
//
// Capability → allowed assert keys. This is the CLOSED set: the schema below
// hard-codes it, and the demo driver switches on `capability` first (to decide
// whether the feature is live yet) then on `assert`. Adding a new assert means
// adding a variant here AND teaching the driver — deliberately not open-ended.
//
//   skeleton  — the walking skeleton: needs materialise at all.
//     · needs_created_count        { count }            one need per intake message
//   triage    — extraction + severity floor + review routing.
//     · distinct_needs_after_dedupe{ count }            needs left once dupes resolve
//     · needs_review_count         { count }            low-confidence → NEEDS_REVIEW
//     · critical_severity_floor    { need_refs[] }      keyword floor forces critical
//   dedupe    — the two-tier dedupe (§F1).
//     · exact_contact_auto_link    { pairs[[dup,orig]] } same phone → deterministic link
//     · duplicate_proposed_pairs   { pairs[[dup,orig]] } fuzzy match → human-merge card
//   match     — deterministic scorer + rationale (§F3).
//     · candidates_suggested       { need_ref, min_count } top-N volunteers offered
//   drift     — SLA timers, nudges, reassignment (§F4).
//     · nudge_before_overdue       { need_ref }          nudge fires pre-deadline
//     · reassign_after_release     { need_ref }          release → reassign proposal
//   evidence  — verification gating (§F5).
//     · close_requires_evidence    { need_ref, required[] } close blocked sans packet
//     · hero_e2e                    { need_ref }            full chain claim→…→Closed proven
//   sitrep    — narrated aggregates (§F6).
//     · stats_match_ledger         { }                  every {{stat}} == SQL truth
//   report    — verified-impact narration + number-integrity/PII gates (§F7).
//     · integrity_guard            { }                  a hallucinated number → template fallback
//     · no_pii                     { }                  generated report Markdown is PII-clean
//   degrade   — "Unplug the AI" (Moonshot #1).
//     · honest_degradation         { }                  degraded loses no need, ≥ NEEDS_REVIEW
//   requester_loop — close the loop with the requester (Moonshot #4).
//     · bilingual_reply_in_source_thread { need_ref }   ta need → bilingual reply in its thread
//   second_scenario — same engine, config-only SLA regime (Moonshot #5).
//     · sla_table_config_drives_drift { }               override → earlier drift deadline, no fork
//
// `pairs` are ORDERED [duplicate_ref, original_ref]: the first is the later
// message that should merge into / propose-merge with the second.

export const capabilitySchema = z.enum([
  'skeleton',
  'triage',
  'dedupe',
  'match',
  'drift',
  'evidence',
  'sitrep',
  'report',
  'judge',
  'assistant',
  'mcp',
  'live_hero',
  // Moonshot batch 1.
  'degrade', // "Unplug the AI" — honest heuristic degradation, no need lost.
  'requester_loop', // Language-matched progress reply into the requester's own thread.
  'second_scenario', // Same engine, different disaster: a config-only SLA regime.
  // Moonshot batch 2.
  'agent_pledge', // An AI agent's pledge is a PROPOSAL a human confirms — tracked identically.
  'counterfactual', // Measured, SIMULATED delta vs a naive group-chat baseline (BASELINE-RULES.md).
  // Moonshot batch 3.
  'auditable_report', // Every donor-report figure carries a 🔍 Audit control → the redacted evidence chain.
  'prewarm_backup', // A live obligation carries a pre-scored backup volunteer for a one-tap hand-off.
]);
export type Capability = z.infer<typeof capabilitySchema>;

/** Documentation + runtime catalog of which asserts each capability owns.
 * Exported so the driver and lint share one source of truth. */
export const ASSERT_CATALOG = {
  skeleton: ['needs_created_count'],
  triage: ['distinct_needs_after_dedupe', 'needs_review_count', 'critical_severity_floor'],
  dedupe: ['exact_contact_auto_link', 'duplicate_proposed_pairs'],
  match: ['candidates_suggested'],
  drift: ['nudge_before_overdue', 'reassign_after_release'],
  evidence: ['close_requires_evidence', 'hero_e2e'],
  sitrep: ['stats_match_ledger'],
  report: ['integrity_guard', 'no_pii'],
  // F8 — the judge experience + the two P1 flourishes, each proven hermetically by the driver.
  judge: ['injector_posts_as_simulator', 'reset_idempotent'],
  assistant: ['answers_open_criticals', 'refuses_out_of_scope'],
  mcp: ['search_needs_matches_ledger'],
  // The LIVE self-serve hero (§F5): runLiveHeroDemo drives the full chain against the real
  // pipeline (the live analog of evidence/hero_e2e), and the App Home board renders over it.
  live_hero: ['hero_live_e2e', 'app_home_board'],
  // Moonshot #1 — "Unplug the AI": with the toggle on, intake runs the HeuristicExtractor even
  // when an LLM is present; no need is ever lost and NEEDS_REVIEW never drops vs AI-online.
  degrade: ['honest_degradation'],
  // Moonshot #4 — the requester gets a bilingual reply threaded into their own source message.
  requester_loop: ['bilingual_reply_in_source_thread'],
  // Moonshot #5 — the scenario's `sla:` override drives a genuinely different drift deadline for
  // the same (type, severity) through the SAME computeSlaDueAtMs; nothing is recompiled.
  second_scenario: ['sla_table_config_drives_drift'],
  // Moonshot #2 — an agent pledge lands as an agent-actor PROPOSAL (not auto-claimed); a human
  // Assign commits it, then it is tracked with the SAME SLA/drift/evidence as a human promise.
  agent_pledge: ['pledge_requires_human_confirm'],
  // Moonshot #3 — the measured, clearly-SIMULATED counterfactual: the naive baseline leaves work
  // unclaimed + double-served and verifies nothing, while Relay dedupes the known pairs and verifies.
  counterfactual: ['counterfactual_beats_group_chat'],
  // Moonshot #6 — every donor-report headline figure carries a 🔍 Audit control whose evidence chain
  // is REDACTED to event type / evidence kind / time / actor role only (PII-free, read-only ledger).
  auditable_report: ['audit_trail_redacted'],
  // Moonshot — a live obligation carries a REAL pre-scored backup volunteer (the #1 alternative from
  // the same deterministic scorer, current assignee excluded) so a reassignment is a one-tap hand-off.
  prewarm_backup: ['backup_prewarmed'],
} as const satisfies Record<Capability, readonly string[]>;

const countParams = z.object({ count: z.number().int().nonnegative() });
/** [duplicate_ref, original_ref] — ordered so `dup` merges into `orig`. */
const pairList = z.object({ pairs: z.array(z.tuple([z.string().min(1), z.string().min(1)])).min(1) });
const evidenceKinds = z.enum(['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']);

// Discriminated on `assert` (globally unique across capabilities), so each
// variant pins BOTH its capability and its params shape.
export const expectationSchema = z.discriminatedUnion('assert', [
  z.object({ capability: z.literal('skeleton'), assert: z.literal('needs_created_count'), params: countParams }),
  z.object({
    capability: z.literal('triage'),
    assert: z.literal('distinct_needs_after_dedupe'),
    params: countParams,
  }),
  z.object({ capability: z.literal('triage'), assert: z.literal('needs_review_count'), params: countParams }),
  z.object({
    capability: z.literal('triage'),
    assert: z.literal('critical_severity_floor'),
    params: z.object({ need_refs: z.array(z.string().min(1)).min(1) }),
  }),
  z.object({ capability: z.literal('dedupe'), assert: z.literal('exact_contact_auto_link'), params: pairList }),
  z.object({ capability: z.literal('dedupe'), assert: z.literal('duplicate_proposed_pairs'), params: pairList }),
  z.object({
    capability: z.literal('match'),
    assert: z.literal('candidates_suggested'),
    params: z.object({ need_ref: z.string().min(1), min_count: z.number().int().positive() }),
  }),
  z.object({
    capability: z.literal('drift'),
    assert: z.literal('nudge_before_overdue'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
  z.object({
    capability: z.literal('drift'),
    assert: z.literal('reassign_after_release'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
  z.object({
    capability: z.literal('evidence'),
    assert: z.literal('close_requires_evidence'),
    params: z.object({ need_ref: z.string().min(1), required: z.array(evidenceKinds).min(1) }),
  }),
  z.object({
    capability: z.literal('evidence'),
    assert: z.literal('hero_e2e'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
  z.object({
    capability: z.literal('sitrep'),
    assert: z.literal('stats_match_ledger'),
    params: z.object({}).optional(),
  }),
  z.object({
    capability: z.literal('report'),
    assert: z.literal('integrity_guard'),
    params: z.object({}).optional(),
  }),
  z.object({
    capability: z.literal('report'),
    assert: z.literal('no_pii'),
    params: z.object({}).optional(),
  }),
  // F8 judge experience — the flood injector posts every intake message as the 🧪 simulator.
  z.object({
    capability: z.literal('judge'),
    assert: z.literal('injector_posts_as_simulator'),
    params: countParams,
  }),
  // F8 — the demo reset is idempotent (run once clears, run again is a safe no-op).
  z.object({
    capability: z.literal('judge'),
    assert: z.literal('reset_idempotent'),
    params: z.object({}).optional(),
  }),
  // P1 Slack AI (Ask-Relay) — grounded, PII-free answer that names the open criticals.
  z.object({
    capability: z.literal('assistant'),
    assert: z.literal('answers_open_criticals'),
    params: z.object({}).optional(),
  }),
  // P1 Slack AI — an out-of-relief-scope question is politely refused.
  z.object({
    capability: z.literal('assistant'),
    assert: z.literal('refuses_out_of_scope'),
    params: z.object({}).optional(),
  }),
  // P1 MCP — the read-only search_needs tool matches an independent ledger recount.
  z.object({
    capability: z.literal('mcp'),
    assert: z.literal('search_needs_matches_ledger'),
    params: z.object({}).optional(),
  }),
  // live_hero — runLiveHeroDemo drives the full chain (against the real pipeline, with stub side
  // effects + a virtual clock) to CLOSED, reassigned to a SECOND volunteer, with a complete packet.
  z.object({
    capability: z.literal('live_hero'),
    assert: z.literal('hero_live_e2e'),
    params: z.object({}).optional(),
  }),
  // live_hero — the App Home operations board renders over the post-hero ledger with all its
  // sections (attention list, drift panel, filters, config panel).
  z.object({
    capability: z.literal('live_hero'),
    assert: z.literal('app_home_board'),
    params: z.object({}).optional(),
  }),
  // degrade (Moonshot #1) — the flood is driven once AI-online and once degraded; degraded loses
  // no need and routes AT LEAST as many to NEEDS_REVIEW as AI-online (honest, never faked).
  z.object({
    capability: z.literal('degrade'),
    assert: z.literal('honest_degradation'),
    params: z.object({}).optional(),
  }),
  // requester_loop (Moonshot #4) — a bilingual progress reply lands in the ta need's SOURCE thread.
  z.object({
    capability: z.literal('requester_loop'),
    assert: z.literal('bilingual_reply_in_source_thread'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
  // second_scenario (Moonshot #5) — the scenario's SLA override yields a different (earlier) drift
  // deadline for the same (type, severity) than the default, via the unchanged engine.
  z.object({
    capability: z.literal('second_scenario'),
    assert: z.literal('sla_table_config_drives_drift'),
    params: z.object({}).optional(),
  }),
  // agent_pledge (Moonshot #2) — an agent pledges (pledge_support) against the named OPEN need. It
  // lands as an agent-actor PROPOSAL that is NOT auto-claimed; an agent self-assign is rejected at
  // the human gate; a human Assign commits it to the agent volunteer, after which it drifts + closes
  // on evidence exactly like a human promise.
  z.object({
    capability: z.literal('agent_pledge'),
    assert: z.literal('pledge_requires_human_confirm'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
  // counterfactual (Moonshot #3) — the SIMULATED group-chat baseline leaves work unclaimed +
  // double-served and verifies nothing; Relay dedupes the known pairs and verifies. All measured.
  z.object({
    capability: z.literal('counterfactual'),
    assert: z.literal('counterfactual_beats_group_chat'),
    params: z.object({}).optional(),
  }),
  // auditable_report (Moonshot #6) — a verified need's audit trail (buildAuditTrail) is redacted to
  // event type / evidence kind / time / actor role only: PII-free, no actor id / evidence ref / note.
  z.object({
    capability: z.literal('auditable_report'),
    assert: z.literal('audit_trail_redacted'),
    params: z.object({}).optional(),
  }),
  // prewarm_backup (Moonshot) — a claimed need carries a genuine pre-scored backup volunteer that is
  // NOT the current assignee; the standby chip renders on the card. Advisory, human-gated to commit.
  z.object({
    capability: z.literal('prewarm_backup'),
    assert: z.literal('backup_prewarmed'),
    params: z.object({ need_ref: z.string().min(1) }),
  }),
]);
export type Expectation = z.infer<typeof expectationSchema>;

// --- Scenario --------------------------------------------------------------

export const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  // Compressed clock (§12.3): 0.02 turns a 45-min SLA into ~54s so drift fires
  // on camera. Never > 1 (a scenario must not slow SLAs down).
  sla_multiplier: z.number().positive().max(1),
  // Optional per-scenario SLA budget overrides (Moonshot #5). Omit (like flood-1) → the engine's
  // default table. A second disaster supplies only the cells it changes; the rest fall back.
  sla: slaOverridesSchema.optional(),
  steps: z.array(stepSchema).min(1),
  expectations: z.array(expectationSchema).min(1),
});
export type Scenario = z.infer<typeof scenarioSchema>;

/**
 * Parse YAML scenario text and validate against the schema. Throws `ZodError`
 * on a schema violation (callers that want granular reporting — e.g. the lint —
 * should `scenarioSchema.safeParse(parseYaml(text))` instead and walk
 * `error.issues`). Returns a fully-typed, trusted `Scenario`.
 */
export function parseScenario(yamlText: string): Scenario {
  const raw: unknown = parseYaml(yamlText);
  return scenarioSchema.parse(raw);
}

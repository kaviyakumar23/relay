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
//   sitrep    — narrated aggregates (§F6).
//     · stats_match_ledger         { }                  every {{stat}} == SQL truth
//
// `pairs` are ORDERED [duplicate_ref, original_ref]: the first is the later
// message that should merge into / propose-merge with the second.

export const capabilitySchema = z.enum(['skeleton', 'triage', 'dedupe', 'match', 'drift', 'evidence', 'sitrep']);
export type Capability = z.infer<typeof capabilitySchema>;

/** Documentation + runtime catalog of which asserts each capability owns.
 * Exported so the driver and lint share one source of truth. */
export const ASSERT_CATALOG = {
  skeleton: ['needs_created_count'],
  triage: ['distinct_needs_after_dedupe', 'needs_review_count', 'critical_severity_floor'],
  dedupe: ['exact_contact_auto_link', 'duplicate_proposed_pairs'],
  match: ['candidates_suggested'],
  drift: ['nudge_before_overdue', 'reassign_after_release'],
  evidence: ['close_requires_evidence'],
  sitrep: ['stats_match_ledger'],
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
    capability: z.literal('sitrep'),
    assert: z.literal('stats_match_ledger'),
    params: z.object({}).optional(),
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

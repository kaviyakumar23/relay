import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { type Expectation, type IntakeMessageStep, type Scenario, scenarioSchema } from './schema';

// scenario:lint — the guard that keeps the demo scenarios honest (BUILD-DOC §12.2,
// §F8). For EACH scenario it (1) validates against the Zod schema, (2) cross-checks
// internal consistency the schema can't express — refs resolve, declared duplicate
// contacts actually match, expectation counts follow from the steps, the hero
// drift->reassign is wired, the frozen composition holds — and (3) does a light
// structural pass over eval/intake_set.jsonl if that (separately-owned) file exists
// yet. flood-1 and heatwave-1 (Moonshot #5 — the config-only second disaster) both
// go through the SAME checks. Any problem prints a precise message and exits 1.
// CLI entrypoint: console.error only.

const FLOOD_URL = new URL('./flood-1.yaml', import.meta.url);
const HEATWAVE_URL = new URL('./heatwave-1.yaml', import.meta.url);
const VOLUNTEERS_URL = new URL('../../seed/volunteers.json', import.meta.url);
const EVAL_SET_URL = new URL('../../eval/intake_set.jsonl', import.meta.url);

/** The frozen composition a scenario must hold (§12.2): code-mix / exact-dup / fuzzy-dup counts. */
interface Composition {
  codeMix: number;
  exact: number;
  fuzzy: number;
}

interface LintResult {
  errors: string[];
  summary: string[];
}

/** Digits only, so "+91 98400 01123", "98400 01123", "9840001123" compare equal. */
function normContact(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Typed lookup of a single expectation by its (globally-unique) assert key. */
function expectByAssert<A extends Expectation['assert']>(
  scenario: Scenario,
  assert: A,
): Extract<Expectation, { assert: A }> | undefined {
  return scenario.expectations.find((e): e is Extract<Expectation, { assert: A }> => e.assert === assert);
}

function loadSeedVolunteerIds(errors: string[]): Set<string> {
  const ids = new Set<string>();
  if (!existsSync(VOLUNTEERS_URL)) {
    errors.push(`seed/volunteers.json not found — volunteer refs cannot be checked`);
    return ids;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(VOLUNTEERS_URL, 'utf8'));
  } catch (err) {
    errors.push(`seed/volunteers.json is not valid JSON: ${(err as Error).message}`);
    return ids;
  }
  if (!Array.isArray(parsed)) {
    errors.push(`seed/volunteers.json must be a JSON array`);
    return ids;
  }
  parsed.forEach((row, i) => {
    const id = (row as { slack_user_id?: unknown })?.slack_user_id;
    if (typeof id !== 'string' || id.length === 0) {
      errors.push(`seed/volunteers.json[${i}] missing string slack_user_id`);
      return;
    }
    if (ids.has(id)) errors.push(`seed/volunteers.json duplicate slack_user_id: ${id}`);
    ids.add(id);
  });
  return ids;
}

/** Structural-only pass over eval/intake_set.jsonl (§10.5) — that file is owned
 * by the eval phase; we never import eval code, just confirm the shape if it
 * exists. Absence is fine (it is drafted later), so it is not an error. */
function lintEvalSet(errors: string[], summary: string[]): void {
  if (!existsSync(EVAL_SET_URL)) {
    summary.push('eval/intake_set.jsonl: not present (skipped)');
    return;
  }
  const lines = readFileSync(EVAL_SET_URL, 'utf8').split('\n');
  let records = 0;
  lines.forEach((line, idx) => {
    const trimmed = line?.trim() ?? '';
    if (trimmed.length === 0) return; // allow blank lines / trailing newline
    const lineNo = idx + 1;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch (err) {
      errors.push(`eval/intake_set.jsonl:${lineNo} not valid JSON: ${(err as Error).message}`);
      return;
    }
    if (typeof row !== 'object' || row === null) {
      errors.push(`eval/intake_set.jsonl:${lineNo} is not a JSON object`);
      return;
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) {
      errors.push(`eval/intake_set.jsonl:${lineNo} missing string "id"`);
    }
    if (typeof rec.text !== 'string' || rec.text.length === 0) {
      errors.push(`eval/intake_set.jsonl:${lineNo} missing string "text"`);
    }
    if (!('gold' in rec) || rec.gold === undefined || rec.gold === null) {
      errors.push(`eval/intake_set.jsonl:${lineNo} missing "gold" label`);
    }
    records += 1;
  });
  summary.push(`eval/intake_set.jsonl: ${records} record(s) structurally OK`);
}

function lintScenario(
  scenarioUrl: URL,
  label: string,
  composition: Composition,
  volunteerIds: Set<string>,
): LintResult {
  const errors: string[] = [];
  const summary: string[] = [];

  // --- Parse + schema-validate ------------------------------------------
  if (!existsSync(scenarioUrl)) {
    errors.push(`demo/scenarios/${label}.yaml not found`);
    return { errors, summary };
  }
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(scenarioUrl, 'utf8'));
  } catch (err) {
    errors.push(`${label}.yaml is not valid YAML: ${(err as Error).message}`);
    return { errors, summary };
  }
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.length ? issue.path.join('.') : '(root)';
      errors.push(`schema: ${path}: ${issue.message}`);
    }
    return { errors, summary }; // no point cross-checking an invalid shape
  }
  const scenario = parsed.data;

  // --- Index the steps ---------------------------------------------------
  const intake: IntakeMessageStep[] = scenario.steps.filter((s): s is IntakeMessageStep => s.kind === 'intake_message');
  const messageIds = new Set<string>();
  for (const m of intake) {
    if (messageIds.has(m.id)) errors.push(`duplicate intake message id: ${m.id}`);
    messageIds.add(m.id);
  }
  const byId = new Map(intake.map((m) => [m.id, m]));
  const resolveNeed = (ref: string, where: string): void => {
    if (!messageIds.has(ref)) errors.push(`${where}: need_ref "${ref}" does not resolve to an intake message`);
  };

  // --- Volunteer / need refs on the action steps -------------------------
  const claims = scenario.steps.filter((s) => s.kind === 'volunteer_claim');
  const replies = scenario.steps.filter((s) => s.kind === 'volunteer_reply');
  for (const c of claims) {
    if (volunteerIds.size > 0 && !volunteerIds.has(c.volunteer_ref)) {
      errors.push(`volunteer_claim: volunteer_ref "${c.volunteer_ref}" not in seed/volunteers.json`);
    }
    resolveNeed(c.need_ref, 'volunteer_claim');
  }
  for (const r of replies) {
    if (volunteerIds.size > 0 && !volunteerIds.has(r.volunteer_ref)) {
      errors.push(`volunteer_reply: volunteer_ref "${r.volunteer_ref}" not in seed/volunteers.json`);
    }
  }

  // --- Detect exact-contact duplicates from the messages themselves ------
  // First message with a given normalized contact is the "original"; any later
  // message repeating it is an exact-contact duplicate that auto-links (§F1).
  const firstByContact = new Map<string, string>();
  const detectedExact: Array<[string, string]> = []; // [duplicate, original]
  for (const m of intake) {
    if (!m.contact) continue;
    const key = normContact(m.contact);
    if (key.length === 0) {
      errors.push(`intake ${m.id}: contact "${m.contact}" has no digits`);
      continue;
    }
    const first = firstByContact.get(key);
    if (first) detectedExact.push([m.id, first]);
    else firstByContact.set(key, m.id);
  }
  const detectedExactSet = new Set(detectedExact.map(([d, o]) => `${d}>${o}`));

  // --- dedupe: exact_contact_auto_link -----------------------------------
  const exactExp = expectByAssert(scenario, 'exact_contact_auto_link');
  if (exactExp) {
    const declared = new Set<string>();
    for (const [dup, orig] of exactExp.params.pairs) {
      declared.add(`${dup}>${orig}`);
      const dm = byId.get(dup);
      const om = byId.get(orig);
      if (!dm) errors.push(`exact_contact_auto_link: "${dup}" is not an intake message`);
      if (!om) errors.push(`exact_contact_auto_link: "${orig}" is not an intake message`);
      if (dm && om) {
        if (!dm.contact || !om.contact) {
          errors.push(`exact_contact_auto_link [${dup},${orig}]: both messages must carry a contact`);
        } else if (normContact(dm.contact) !== normContact(om.contact)) {
          errors.push(
            `exact_contact_auto_link [${dup},${orig}]: contacts differ (${dm.contact} vs ${om.contact}) — not an exact match`,
          );
        }
      }
    }
    for (const key of detectedExactSet) {
      if (!declared.has(key)) {
        errors.push(
          `exact_contact_auto_link: messages ${key.replace('>', ' + ')} share a contact but are not declared`,
        );
      }
    }
    for (const key of declared) {
      if (!detectedExactSet.has(key)) {
        errors.push(`exact_contact_auto_link: declared pair ${key.replace('>', ' + ')} is not an actual contact match`);
      }
    }
  } else {
    errors.push(`missing expectation: dedupe/exact_contact_auto_link`);
  }

  // --- dedupe: duplicate_proposed_pairs (fuzzy) --------------------------
  const fuzzyExp = expectByAssert(scenario, 'duplicate_proposed_pairs');
  if (fuzzyExp) {
    for (const [dup, orig] of fuzzyExp.params.pairs) {
      const dm = byId.get(dup);
      const om = byId.get(orig);
      if (!dm) errors.push(`duplicate_proposed_pairs: "${dup}" is not an intake message`);
      if (!om) errors.push(`duplicate_proposed_pairs: "${orig}" is not an intake message`);
      // A fuzzy dup must NOT be an exact-contact match, else it should auto-link.
      if (dm?.contact && om?.contact && normContact(dm.contact) === normContact(om.contact)) {
        errors.push(`duplicate_proposed_pairs [${dup},${orig}]: contacts match — declare as exact_contact_auto_link`);
      }
    }
  } else {
    errors.push(`missing expectation: dedupe/duplicate_proposed_pairs`);
  }

  const exactDupCount = detectedExact.length;
  const fuzzyDupCount = fuzzyExp?.params.pairs.length ?? 0;

  // --- skeleton: needs_created_count == number of intake messages --------
  const skeletonExp = expectByAssert(scenario, 'needs_created_count');
  if (skeletonExp) {
    if (skeletonExp.params.count !== intake.length) {
      errors.push(`needs_created_count = ${skeletonExp.params.count} but there are ${intake.length} intake messages`);
    }
  } else {
    errors.push(`missing expectation: skeleton/needs_created_count`);
  }

  // --- triage: distinct == created - exact_dupes - fuzzy_dupes -----------
  const distinctExp = expectByAssert(scenario, 'distinct_needs_after_dedupe');
  if (distinctExp) {
    const expectedDistinct = intake.length - exactDupCount - fuzzyDupCount;
    if (distinctExp.params.count !== expectedDistinct) {
      errors.push(
        `distinct_needs_after_dedupe = ${distinctExp.params.count} but ${intake.length} messages ` +
          `- ${exactDupCount} exact - ${fuzzyDupCount} fuzzy = ${expectedDistinct}`,
      );
    }
  } else {
    errors.push(`missing expectation: triage/distinct_needs_after_dedupe`);
  }

  // --- triage: needs_review_count sane -----------------------------------
  const reviewExp = expectByAssert(scenario, 'needs_review_count');
  if (reviewExp) {
    if (reviewExp.params.count > intake.length) {
      errors.push(`needs_review_count = ${reviewExp.params.count} exceeds ${intake.length} intake messages`);
    }
  } else {
    errors.push(`missing expectation: triage/needs_review_count`);
  }

  // --- triage: critical_severity_floor refs resolve ----------------------
  const floorExp = expectByAssert(scenario, 'critical_severity_floor');
  if (floorExp) {
    for (const ref of floorExp.params.need_refs) resolveNeed(ref, 'critical_severity_floor');
  } else {
    errors.push(`missing expectation: triage/critical_severity_floor`);
  }

  // --- match / drift / evidence need_refs resolve ------------------------
  const matchExp = expectByAssert(scenario, 'candidates_suggested');
  if (matchExp) resolveNeed(matchExp.params.need_ref, 'candidates_suggested');
  else errors.push(`missing expectation: match/candidates_suggested`);

  const nudgeExp = expectByAssert(scenario, 'nudge_before_overdue');
  if (nudgeExp) resolveNeed(nudgeExp.params.need_ref, 'nudge_before_overdue');

  const reassignExp = expectByAssert(scenario, 'reassign_after_release');
  if (reassignExp) resolveNeed(reassignExp.params.need_ref, 'reassign_after_release');
  else errors.push(`missing expectation: drift/reassign_after_release`);

  const evidenceExp = expectByAssert(scenario, 'close_requires_evidence');
  if (evidenceExp) resolveNeed(evidenceExp.params.need_ref, 'close_requires_evidence');
  else errors.push(`missing expectation: evidence/close_requires_evidence`);

  const heroExp = expectByAssert(scenario, 'hero_e2e');
  if (heroExp) resolveNeed(heroExp.params.need_ref, 'hero_e2e');
  else errors.push(`missing expectation: evidence/hero_e2e`);

  // --- Hero wiring: release -> reassign target the same claimed need ------
  const releaseReply = replies.find((r) => r.reply === 'release');
  if (releaseReply) {
    const priorClaim = claims.find((c) => c.volunteer_ref === releaseReply.volunteer_ref);
    if (!priorClaim) {
      errors.push(`hero: volunteer ${releaseReply.volunteer_ref} releases but never claims — no obligation to release`);
    } else if (reassignExp && priorClaim.need_ref !== reassignExp.params.need_ref) {
      errors.push(
        `hero: released need "${priorClaim.need_ref}" != reassign_after_release need "${reassignExp.params.need_ref}"`,
      );
    }
  }

  // --- Composition sanity: each scenario's frozen mix (§12.2) ------------
  const codeMix = intake.filter((m) => m.language === 'ta-en').length;
  if (codeMix !== composition.codeMix) {
    errors.push(`${label}: expected exactly ${composition.codeMix} Tamil-English (ta-en) message(s), found ${codeMix}`);
  }
  if (exactDupCount !== composition.exact) {
    errors.push(`${label}: expected exactly ${composition.exact} exact-contact duplicate(s), found ${exactDupCount}`);
  }
  if (fuzzyDupCount !== composition.fuzzy) {
    errors.push(`${label}: expected exactly ${composition.fuzzy} fuzzy duplicate(s), found ${fuzzyDupCount}`);
  }

  summary.push(
    `${label}: ${intake.length} intake messages (${codeMix} code-mix), ` +
      `${claims.length} claim(s) + ${replies.length} repl(y/ies), ${scenario.expectations.length} expectations`,
  );
  summary.push(`${label} dedupe: ${exactDupCount} exact-contact + ${fuzzyDupCount} fuzzy duplicate(s)`);

  return { errors, summary };
}

function main(): number {
  const errors: string[] = [];
  const summary: string[] = [];
  // The seed roster is loaded once and shared across scenarios (volunteer refs are checked per file).
  const volunteerIds = loadSeedVolunteerIds(errors);

  const scenarios: Array<{ url: URL; label: string; composition: Composition }> = [
    { url: FLOOD_URL, label: 'flood-1', composition: { codeMix: 3, exact: 2, fuzzy: 1 } },
    { url: HEATWAVE_URL, label: 'heatwave-1', composition: { codeMix: 2, exact: 1, fuzzy: 1 } },
  ];
  for (const s of scenarios) {
    const res = lintScenario(s.url, s.label, s.composition, volunteerIds);
    errors.push(...res.errors);
    summary.push(...res.summary);
  }
  lintEvalSet(errors, summary);

  if (errors.length > 0) {
    console.error(`scenario:lint FAILED — ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    return 1;
  }
  console.error('scenario:lint OK');
  for (const s of summary) console.error(`  · ${s}`);
  return 0;
}

if (process.argv[1]?.endsWith('lint.ts')) {
  process.exit(main());
}

export { lintScenario };

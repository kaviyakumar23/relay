import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { config } from '../src/config';
import type { NeedDraft } from '../src/llm/needDraft';
import { NeedDraftSchema } from '../src/llm/needDraft';
import { createLlm, LlmParseError, LlmRefusalError } from '../src/llm/provider';
import { HeuristicExtractor, LlmExtractor } from '../src/pipeline/extract';
import type { Aggregate, EvalLanguage, EvalResult } from './score';
import { aggregate, FLOOR_KEYWORDS, hitsCriticalFloor, scoreCase } from './score';

// eval/run.ts — `npm run eval` (BUILD-DOC §10.5). Loads and Zod-validates the 40-case
// gold set, asserts the dataset's honesty invariants, prints composition, then scores
// the P-1 extractor(s). The deterministic HeuristicExtractor is ALWAYS scored so the
// harness prints real offline baseline numbers with zero env; when an OpenAI/Anthropic
// key is present, the LlmExtractor path is ALSO scored and printed side by side. Every
// number is computed by eval/score.ts from real predictions — none is fabricated
// (CLAUDE.md eval-honesty). eval/ imports from src/ only (Docker excludes eval/).
//
// All human-readable output goes through console.error (repo CLI convention; see
// src/lib/migrate.ts). logger is for structured service logs, not eval reports.

const EvalCaseSchema = z.object({
  id: z.string().regex(/^E\d{2}$/),
  text: z.string().min(1),
  language: z.enum(['en', 'ta-en']),
  gold: NeedDraftSchema,
  // dedupe_cluster groups a candidate near-duplicate pair; the ground-truth merge
  // verdict is tagged in notes as `dup-verdict:merge` or `dup-verdict:distinct`.
  dedupe_cluster: z.string().optional(),
  notes: z.string().optional(),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const EXPECTED_COUNT = 40;

/** Parse + Zod-validate every JSONL line. Hard-fail (throw) on the first invalid line,
 *  naming the line number and id so the frozen set can never silently drift. */
export function loadCases(raw: string): EvalCase[] {
  const lines = raw.split('\n');
  const cases: EvalCase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line === '') continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${i + 1}: invalid JSON — ${(err as Error).message}`);
    }
    const parsed = EvalCaseSchema.safeParse(json);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((iss) => `${iss.path.join('.') || '(root)'}: ${iss.message}`).join('; ');
      const id = typeof (json as { id?: unknown }).id === 'string' ? (json as { id: string }).id : '?';
      throw new Error(`line ${i + 1} (${id}): schema validation failed — ${detail}`);
    }
    cases.push(parsed.data);
  }
  return cases;
}

interface DedupeCluster {
  id: string;
  ids: string[];
  verdict: 'merge' | 'distinct' | 'mixed';
}

function dedupeClusters(cases: EvalCase[]): DedupeCluster[] {
  const groups = new Map<string, EvalCase[]>();
  for (const c of cases) {
    if (c.dedupe_cluster === undefined) continue;
    const g = groups.get(c.dedupe_cluster) ?? [];
    g.push(c);
    groups.set(c.dedupe_cluster, g);
  }
  const clusters: DedupeCluster[] = [];
  for (const [id, members] of groups) {
    const verdicts = new Set(members.map((m) => (m.notes?.includes('dup-verdict:merge') ? 'merge' : 'distinct')));
    const verdict = verdicts.size === 1 ? [...verdicts][0] : 'mixed';
    clusters.push({ id, ids: members.map((m) => m.id), verdict: verdict as DedupeCluster['verdict'] });
  }
  return clusters;
}

/** Honesty guardrails on the frozen set. Throws on any violation so a bad edit fails
 *  `npm run eval` loudly instead of publishing a quietly-wrong dataset. */
export function validateDataset(cases: EvalCase[]): void {
  if (cases.length !== EXPECTED_COUNT) {
    throw new Error(`expected exactly ${EXPECTED_COUNT} cases, found ${cases.length}`);
  }
  // ids are E01..E40, unique and sequential.
  const seen = new Set<string>();
  for (let i = 0; i < cases.length; i++) {
    const expected = `E${String(i + 1).padStart(2, '0')}`;
    const id = cases[i]?.id;
    if (id !== expected) throw new Error(`case ${i + 1}: expected id ${expected}, found ${id}`);
    if (seen.has(expected)) throw new Error(`duplicate id ${expected}`);
    seen.add(expected);
  }
  // Severity floor consistency: a message hits the critical floor IFF its gold severity
  // is critical. (Floor keyword ⟹ critical, and every critical is floor-justified.)
  for (const c of cases) {
    const floored = hitsCriticalFloor(c.text);
    const critical = c.gold.severity === 'critical';
    if (floored !== critical) {
      throw new Error(
        `${c.id}: floor/severity mismatch — floor keyword ${floored ? 'present' : 'absent'} but severity=${c.gold.severity}. ` +
          'Every critical must contain a floor keyword and no non-critical case may.',
      );
    }
  }
  // Dedupe clusters: exactly 3 candidate pairs, each size 2, verdicts 2 merge + 1 distinct.
  const clusters = dedupeClusters(cases);
  if (clusters.length !== 3) throw new Error(`expected 3 dedupe candidate pairs, found ${clusters.length}`);
  for (const cl of clusters) {
    if (cl.ids.length !== 2) throw new Error(`dedupe cluster ${cl.id} has ${cl.ids.length} members, expected 2`);
    if (cl.verdict === 'mixed') throw new Error(`dedupe cluster ${cl.id} has conflicting merge verdicts`);
  }
  const merge = clusters.filter((c) => c.verdict === 'merge').length;
  const distinct = clusters.filter((c) => c.verdict === 'distinct').length;
  if (merge !== 2 || distinct !== 1) {
    throw new Error(`expected 2 merge + 1 distinct dedupe pairs, found ${merge} merge + ${distinct} distinct`);
  }
  // At least 6 floor-justified criticals (BUILD-DOC §10.5 / F1 acceptance).
  const criticals = cases.filter((c) => c.gold.severity === 'critical').length;
  if (criticals < 6) throw new Error(`expected >= 6 critical cases, found ${criticals}`);
  // Every need type is represented.
  const types = new Set(cases.map((c) => c.gold.type));
  for (const t of ['medical', 'rescue', 'food', 'water', 'shelter', 'transport', 'other']) {
    if (!types.has(t as NeedDraft['type'])) throw new Error(`need type '${t}' missing from the gold set`);
  }
}

function printComposition(cases: EvalCase[]): void {
  const english = cases.filter((c) => c.language === 'en' && c.dedupe_cluster === undefined).length;
  const tamil = cases.filter((c) => c.language === 'ta-en' && c.dedupe_cluster === undefined).length;
  const noisy = cases.filter((c) => c.dedupe_cluster !== undefined).length;

  const byType = new Map<string, number>();
  const bySeverity = new Map<string, number>();
  for (const c of cases) {
    byType.set(c.gold.type, (byType.get(c.gold.type) ?? 0) + 1);
    bySeverity.set(c.gold.severity, (bySeverity.get(c.gold.severity) ?? 0) + 1);
  }
  const unknownLocality = cases.filter((c) => c.gold.locality_guess === null).length;
  const noContact = cases.filter((c) => c.gold.contact_raw === null).length;
  const inferablePeople = cases.filter((c) => c.gold.provenance.people_count?.status === 'inferred').length;
  const clusters = dedupeClusters(cases);

  const fmt = (m: Map<string, number>) =>
    [...m.entries()]
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');

  console.error('Relay intake extraction eval — dataset composition (BUILD-DOC §10.5)');
  console.error('────────────────────────────────────────────────────────────────────');
  console.error(`  total cases:            ${cases.length}`);
  console.error(`  English:                ${english}`);
  console.error(`  Tamil-English code-mix: ${tamil}`);
  console.error(`  noisy / duplicate:      ${noisy}`);
  console.error(`  by type:                ${fmt(byType)}`);
  console.error(`  by severity:            ${fmt(bySeverity)}`);
  console.error(`  critical (floor-justified): ${bySeverity.get('critical') ?? 0}`);
  console.error(`  unknown locality:       ${unknownLocality}`);
  console.error(`  no contact:             ${noContact}`);
  console.error(`  people_count inferred-only: ${inferablePeople}`);
  console.error('  dedupe candidate pairs:');
  for (const cl of clusters) {
    console.error(`    - ${cl.id} [${cl.ids.join(', ')}] → ${cl.verdict}`);
  }
  console.error(`  floor keywords (${FLOOR_KEYWORDS.length}): ${FLOOR_KEYWORDS.join(', ')}`);
  console.error('');
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function printMetrics(agg: Aggregate): void {
  const fa = agg.fieldAccuracy;
  console.error('Extraction accuracy (over attempted extractions):');
  console.error(`  overall field accuracy: ${pct(fa.overall)}  (n=${agg.attempted}/${agg.n} attempted)`);
  console.error(`    type:          ${pct(fa.type)}`);
  console.error(`    severity:      ${pct(fa.severity)}`);
  console.error(`    locality_guess:${pct(fa.locality_guess)}`);
  console.error(`    people_count:  ${pct(fa.people_count)}`);
  console.error(`    contact_raw:   ${pct(fa.contact_raw)}`);
  console.error(`    provenance:    ${pct(fa.provenance)}`);
  console.error(`  critical recall:    ${pct(agg.criticalRecall)}`);
  console.error(`  critical precision: ${pct(agg.criticalPrecision)}`);
  console.error(`  needs-review rate:  ${pct(agg.needsReviewRate)}`);
  console.error('  per-language:');
  for (const lang of ['en', 'ta-en'] as EvalLanguage[]) {
    const s = agg.perLanguage[lang];
    if (s === undefined) continue;
    console.error(`    ${lang}: field ${pct(s.fieldAccuracy)} · critical recall ${pct(s.criticalRecall)} (n=${s.n})`);
  }
}

// ── EXTRACTOR SEAM ─────────────────────────────────────────────────────────────
// A named extractor maps a message to a NeedDraft, or null when it punts to
// NEEDS_REVIEW (parse/refusal failure after the provider's repair pass — scored as a
// deferral, never as a correct answer).
interface NamedExtractor {
  label: string;
  run: (text: string) => Promise<NeedDraft | null>;
}

/** The deterministic offline baseline — always available, zero env. */
function heuristicRunner(): NamedExtractor {
  const ex = new HeuristicExtractor();
  return { label: 'Heuristic baseline (deterministic · no API key)', run: (text) => ex.extract(text) };
}

/** The real P-1 provider path — only when a key is configured. Maps a parse/refusal
 * failure to null (needs-review), exactly as the live pipeline does. */
function llmRunner(): NamedExtractor | null {
  const hasKey = config.llmProvider === 'anthropic' ? config.anthropicApiKey !== '' : config.openaiApiKey !== '';
  if (!hasKey) return null;
  const ex = new LlmExtractor(createLlm());
  return {
    label: `LLM path (${ex.name})`,
    run: async (text) => {
      try {
        return await ex.extract(text);
      } catch (err) {
        if (err instanceof LlmParseError || err instanceof LlmRefusalError) return null;
        throw err;
      }
    },
  };
}

async function scoreExtractor(named: NamedExtractor, cases: EvalCase[]): Promise<void> {
  console.error(`── ${named.label} ──`);
  const results: EvalResult[] = [];
  for (const c of cases) {
    const predicted = await named.run(c.text);
    results.push({ id: c.id, language: c.language, score: scoreCase(c.gold, predicted) });
  }
  printMetrics(aggregate(results));
  console.error('');
}

async function main(): Promise<number> {
  const raw = readFileSync(new URL('./intake_set.jsonl', import.meta.url), 'utf8');
  const cases = loadCases(raw);
  validateDataset(cases);
  printComposition(cases);

  // Always score the deterministic baseline so `npm run eval` prints real offline numbers.
  await scoreExtractor(heuristicRunner(), cases);

  // Also score the real provider when a key is present; otherwise say so honestly.
  const llm = llmRunner();
  if (llm !== null) {
    await scoreExtractor(llm, cases);
  } else {
    console.error('LLM path: SKIPPED — no OPENAI_API_KEY / ANTHROPIC_API_KEY set.');
    console.error('The heuristic baseline above is the offline number; set a key to also score the P-1 provider.');
    console.error('');
  }
  return 0;
}

if (process.argv[1]?.endsWith('run.ts')) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`eval failed: ${(err as Error).message}`);
      process.exit(1);
    });
}

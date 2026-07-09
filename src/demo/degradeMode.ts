import type { LlmProvider } from '../llm/provider';
import { type Extractor, HeuristicExtractor, LlmExtractor } from '../pipeline/extract';

// Moonshot #1 — "Unplug the AI". A runtime toggle that forces Relay into AI-degraded
// mode: heuristic extraction + deterministic template narration EVEN WHEN an LLM key is
// present, so a judge can watch Relay keep working with its AI disconnected. The
// degradation is HONEST — no LLM interpretation means confidence genuinely drops and more
// needs route to NEEDS_REVIEW (see the assertion idea at the foot of this file). The
// ledger, matching, and evidence gates are never touched; only the two seams the LLM
// participates in (P-1 extraction, P-5/P-6 narration) fall back to their deterministic
// baselines. Nothing is recompiled or forked — the same engine runs the heuristic path it
// already uses for hermetic tests, demo, and offline boots.
//
// This module is self-contained and pure (aside from the small process-lifetime toggle
// singleton). The integrator wires the Slack command, the per-job extractor pick, and the
// banner surfaces — see the INTEGRATOR NOTE at the foot of this file.

/** Process-lifetime toggle. Mutable by design: one flag flipped by a slash command. */
export interface DegradeState {
  /** true ⇒ ignore any configured LLM; run heuristic extraction + template narration. */
  llmDisabled: boolean;
}

/** The banner shown while the AI is unplugged (App Home, judge welcome, command acks). */
export const DEGRADED_BANNER = '🔌 AI DEGRADED — heuristic extraction, no LLM';
/** The banner shown while the AI is connected. */
export const ONLINE_BANNER = 'AI online';

// The single process-lifetime toggle. Not persisted — a fresh boot comes up AI-online.
const state: DegradeState = { llmDisabled: false };

/** Read the live toggle. Returns the singleton so callers see the current flag per-read. */
export function getDegrade(): DegradeState {
  return state;
}

/** Flip the toggle. `on` = true unplugs the AI (degraded); false reconnects it. */
export function setDegrade(on: boolean): void {
  state.llmDisabled = on;
}

/** The banner for the current toggle state — degraded vs online. */
export function describe(): string {
  return state.llmDisabled ? DEGRADED_BANNER : ONLINE_BANNER;
}

/**
 * Pick the P-1 extractor honoring the degrade flag. Mirrors how server.ts chooses the
 * extractor today (LlmExtractor when a provider is configured, else the deterministic
 * HeuristicExtractor) but the degrade flag forces the heuristic even with an llm present.
 * Returns HeuristicExtractor when degraded OR no llm; otherwise LlmExtractor(llm).
 */
export function selectExtractor(deps: { llm?: LlmProvider; degraded: boolean }): Extractor {
  if (deps.degraded || deps.llm === undefined) return new HeuristicExtractor();
  return new LlmExtractor(deps.llm);
}

/**
 * The narration provider for sitrep/report, honoring the degrade flag. Returns undefined
 * when degraded so narrateWithIntegrity takes the deterministic template path (its llm?
 * param already forces the template when undefined). Otherwise passes the llm through
 * unchanged.
 */
export function narrationLlmFor(llm: LlmProvider | undefined, degraded: boolean): LlmProvider | undefined {
  return degraded ? undefined : llm;
}

// INTEGRATOR NOTE — wiring this toggle live (do NOT edit slackApp/server from here):
//   (a) Slash command:
//         '/relay demo degrade llm' → setDegrade(true)
//         '/relay demo degrade off' → setDegrade(false)
//       Ack each with describe() as the banner, then post a labelled note to the channel.
//   (b) intakeJob: build the extractor PER JOB via
//         selectExtractor({ llm, degraded: getDegrade().llmDisabled })
//       so the toggle takes effect live (do not capture one extractor at boot).
//   (c) sitrep/report: pass narrationLlmFor(rationaleLlm, getDegrade().llmDisabled) as the
//       narrate `llm` so degraded runs use the deterministic template.
//   (d) App Home / the judge welcome: render describe() (or DEGRADED_BANNER) when
//       getDegrade().llmDisabled is true, so the judge always sees the AI is unplugged.
//
// DEMO ASSERTION IDEA (honest degradation): drive N identical intake messages through the
// pipeline once AI-online and once degraded. In BOTH runs all N create needs (no message is
// ever lost). In the degraded run, STRICTLY MORE of them land in NEEDS_REVIEW than in the AI
// run — the heuristic can't interpret ambiguous language the LLM could, so confidence
// honestly drops. Never equalize the two; the gap is the whole point.

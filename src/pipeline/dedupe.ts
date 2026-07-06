import { needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { DedupeCandidate, EventStore } from '../ledger/store/eventStore';
import type { Actor } from '../ledger/types';
import { logger } from '../lib/logger';

// The dedupe engine (BUILD-DOC §16.4). After a fresh need is extracted, it looks
// back over recent same-type needs and AUTO-DETECTS likely duplicates, emitting a
// DuplicateProposed event per candidate. It NEVER emits DuplicateConfirmed: merging
// is a consequential transition that only a human confirms (CLAUDE.md invariant #2).
//
// Two signals, in priority order:
//   • EXACT   — same keyed contact blind index (src/lib/contactHash.ts). Highest
//               confidence (score 1.0); works across localities.
//   • FUZZY   — same incident reworded: cosine over embeddings when both present,
//               else a trigram Jaccard over the PII-free dedupe_text. Only when the
//               fresh need has a locality (cross-locality fuzzy is too noisy).
//
// Everything here is deterministic and hermetic — no network, no embeddings required
// (the trigram path runs with zero env), so tests and demo exercise the real logic.

/** Look-back window: only needs created within 24h before the fresh one are candidates. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cosine floor for the embedding path (same-incident rewordings cluster tightly). */
const EMBED_COSINE_THRESHOLD = 0.86;
/** Trigram-Jaccard floor for the text fallback path. */
const TRIGRAM_JACCARD_THRESHOLD = 0.5;

/** DuplicateProposed is a system detection (no human gate) — attributed to the engine. */
const DEDUPE_ACTOR: Actor = { type: 'agent', id: 'relay-dedupe' };

export type DedupeReason = 'exact_contact' | 'similar';

export interface DedupeProposal {
  otherNeedId: string;
  score: number;
  reason: DedupeReason;
}

export interface RunDedupeArgs {
  needId: string;
  publicId: string;
  type: string;
  localityId: number | null;
  contactHash: string | null;
  dedupeText: string | null;
  embedding: number[] | null;
  createdAtMs: number;
  store: EventStore;
  service: NeedService;
  now: number;
}

/**
 * Detect likely duplicates of a freshly-extracted need and emit one DuplicateProposed
 * per match. Returns the proposals (for logging/tests). Advisory: a rejected/suppressed
 * proposal event is logged, never thrown — dedupe must never lose or block a need.
 */
export async function runDedupe(args: RunDedupeArgs): Promise<{ proposals: DedupeProposal[] }> {
  const candidates = await args.store.findDedupeCandidates({
    type: args.type,
    localityId: args.localityId,
    sinceMs: args.createdAtMs - DEDUPE_WINDOW_MS,
    excludeNeedId: args.needId,
    now: args.now,
  });

  const proposals: DedupeProposal[] = [];
  for (const candidate of candidates) {
    // EXACT beats fuzzy: same caller is the strongest signal, regardless of wording.
    if (args.contactHash !== null && candidate.contactHash === args.contactHash) {
      proposals.push({ otherNeedId: candidate.needId, score: 1, reason: 'exact_contact' });
      continue;
    }
    // FUZZY only with a locality on the fresh need (cross-locality text match too noisy).
    if (args.localityId === null) continue;
    const sim = fuzzyScore(args, candidate);
    if (sim !== null) {
      proposals.push({ otherNeedId: candidate.needId, score: round(sim), reason: 'similar' });
    }
  }

  for (const proposal of proposals) {
    await emitProposal(args, proposal);
  }
  return { proposals };
}

/** Emit ONE DuplicateProposed on the fresh need. Keyed by the candidate so re-runs collapse. */
async function emitProposal(args: RunDedupeArgs, proposal: DedupeProposal): Promise<void> {
  const result = await args.service.dispatch(
    args.needId,
    {
      type: 'DuplicateProposed',
      payload: { other_need_id: proposal.otherNeedId, score: proposal.score, reason: proposal.reason },
    },
    {
      actor: DEDUPE_ACTOR,
      at: new Date(args.now).toISOString(),
      idempotencyKey: needEventKey(args.needId, 'DuplicateProposed', proposal.otherNeedId),
      now: args.now,
    },
  );
  if (result.status === 'rejected' || result.status === 'conflict') {
    // Advisory only: log and carry on so a need is never blocked by dedupe.
    logger.warn(
      {
        need_id: args.needId,
        other_need_id: proposal.otherNeedId,
        reason: proposal.reason,
        status: result.status,
        code: result.code,
      },
      'dedupe: DuplicateProposed not applied',
    );
    return;
  }
  logger.info(
    {
      need_id: args.needId,
      public_id: args.publicId,
      other_need_id: proposal.otherNeedId,
      reason: proposal.reason,
      score: proposal.score,
      status: result.status,
    },
    'dedupe: duplicate proposed',
  );
}

/** Fuzzy similarity above threshold → the score; else null (embedding path preferred). */
function fuzzyScore(args: RunDedupeArgs, candidate: DedupeCandidate): number | null {
  if (args.embedding !== null && candidate.embedding !== null) {
    const cos = cosine(args.embedding, candidate.embedding);
    return cos !== null && cos >= EMBED_COSINE_THRESHOLD ? cos : null;
  }
  if (args.dedupeText !== null && candidate.dedupeText !== null) {
    const j = trigramJaccard(args.dedupeText, candidate.dedupeText);
    return j >= TRIGRAM_JACCARD_THRESHOLD ? j : null;
  }
  return null;
}

/** Cosine similarity of two equal-length, non-zero vectors; null if incomparable. */
function cosine(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Jaccard overlap of the two strings' character trigram sets (a simple pg_trgm stand-in). */
function trigramJaccard(a: string, b: string): number {
  const sa = trigrams(a);
  const sb = trigrams(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const g of sa) if (sb.has(g)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Lower-cased, whitespace-collapsed character trigrams. */
function trigrams(s: string): Set<string> {
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= norm.length; i++) grams.add(norm.slice(i, i + 3));
  return grams;
}

/** Keep the score compact and stable in the event payload. */
function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

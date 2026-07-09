import { getDegrade, selectExtractor } from '../demo/degradeMode';
import type { CardRenderOptions, Notifier } from '../ingest/notifier';
import { needCreatedKey, needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { EventStore } from '../ledger/store/eventStore';
import type { Actor, ProjectedNeed } from '../ledger/types';
import { contactHash } from '../lib/contactHash';
import { logger } from '../lib/logger';
import type { ContactVault } from '../lib/vault';
import type { LlmProvider } from '../llm/provider';
import { normalizeContact } from './contact';
import { runDedupe } from './dedupe';
import type { Extractor } from './extract';
import { runExtraction } from './extract';
import type { IntakeJob, JobHandler, JobTransient } from './queue';

// The intake worker (BUILD-DOC §16.2/§16.3). Turns an IntakeJob into a NeedCreated
// ledger event, runs P-1 extraction, and posts a dispatch card that reflects the
// extraction:
//   createNeed (NEW / other / low)
//     → runExtraction(transient.text) → ExtractionCompletedPayload (+ contact)
//     → vault the contact BEFORE dispatch (PII, invariant #5)
//     → dispatch ExtractionCompleted (agent actor → TRIAGED or NEEDS_REVIEW)
//     → post the card from the resulting projection
// Business idempotency: needCreatedKey(team,channel,ts) collapses redeliveries, and
// the ExtractionCompleted event is keyed by needEventKey(needId,type,ts). Zero-copy
// (invariant #5): raw text rides transiently and is never persisted or logged — we
// log only derived fields (need_type/severity/needs_review/text_len).

/** NeedCreated is a non-consequential (agent) transition — no human gate. */
const INTAKE_ACTOR: Actor = { type: 'agent', id: 'relay-intake' };
/** ExtractionCompleted is emitted by the extraction agent (no human gate, §6.2). */
const EXTRACT_ACTOR: Actor = { type: 'agent', id: 'relay-extract' };

export interface IntakeJobDeps {
  service: NeedService;
  notifier: Notifier;
  /** Pin the P-1 extractor explicitly (tests/demo pass the deterministic heuristic here). When
   * omitted, the extractor is chosen PER JOB via selectExtractor({ llm, degraded }) so the live
   * "/relay demo degrade llm" toggle takes effect without recapturing an extractor at boot. */
  extractor?: Extractor;
  /** LLM provider for per-job extractor selection (used only when `extractor` is not pinned):
   * an LlmExtractor when present + not degraded, else the deterministic HeuristicExtractor. */
  llm?: LlmProvider;
  /** Encrypted contact vault. Undefined = vaulting disabled (dev without a key). */
  vault?: ContactVault;
  /** The event store — when present, dedupe runs after extraction (setDedupeKeys +
   * runDedupe auto-detect DuplicateProposed). Undefined = dedupe disabled. */
  store?: EventStore;
  /** Key for the contact blind index (config.contactVaultKey in live; the fixed dev
   * salt in hermetic runs when unset). PII-safe: only a keyed one-way hash is stored. */
  contactHashKey?: string;
  /** Clock for the event timestamp + projection (defaults to Date.now). */
  now?: () => number;
  /** Override the creating actor (defaults to the intake agent). */
  actor?: Actor;
  isDemo?: boolean;
}

/** Result of the extraction step: the fresh projection + the normalized contact
 * (kept in-memory only, for the blind index — never persisted or logged as itself). */
interface ExtractionOutcome {
  projection: ProjectedNeed;
  contact: string | null;
}

/** Keyed one-way blind index of the beneficiary number, or null when there is none.
 * Normalizes the display form back to canonical digits first so the SAME number always
 * hashes identically. The plaintext never leaves this function. */
function deriveContactHash(contact: string | null, keyHex?: string): string | null {
  if (contact === null) return null;
  const digits = normalizeContact(contact)?.digits ?? null;
  return digits === null ? null : contactHash(digits, keyHex);
}

/** A PII-free derived signal for trigram similarity: need type + resolved locality +
 * headcount. Contains only structured, card-visible fields — never raw message text. */
function buildDedupeText(need: ProjectedNeed): string | null {
  const parts: string[] = [need.type];
  if (need.location_text !== null && need.location_text !== '') parts.push(need.location_text);
  if (need.people_count !== null) parts.push(`for ${need.people_count}`);
  const text = parts.join(' ').trim();
  return text.length > 0 ? text : null;
}

/**
 * Run P-1 extraction and apply it to a freshly-created need. Vaults any contact
 * BEFORE the dispatch (so the reveal path is backed the instant the card renders),
 * then dispatches ExtractionCompleted and returns the resulting projection. Never
 * leaks raw text or the contact into a log line.
 */
async function applyExtraction(
  needId: string,
  job: IntakeJob,
  text: string,
  nowMs: number,
  deps: IntakeJobDeps,
  extractor: Extractor,
  fallback: ProjectedNeed,
): Promise<ExtractionOutcome> {
  const { payload, contact } = await runExtraction(text, extractor);

  if (contact !== null && deps.vault !== undefined) {
    await deps.vault.put(needId, contact);
  }

  const result = await deps.service.dispatch(
    needId,
    { type: 'ExtractionCompleted', payload },
    {
      actor: EXTRACT_ACTOR,
      at: new Date(nowMs).toISOString(),
      idempotencyKey: needEventKey(needId, 'ExtractionCompleted', job.messageTs),
      now: nowMs,
    },
  );

  const projection = result.need ?? (await deps.service.getNeed(needId, nowMs)) ?? fallback;
  logger.info(
    {
      need_id: needId,
      need_type: payload.need_type,
      severity: projection.severity,
      state: projection.state,
      needs_review: payload.needs_review === true,
      contact_vaulted: contact !== null && deps.vault !== undefined,
      text_len: text.length,
    },
    'intake: extraction applied',
  );
  return { projection, contact };
}

/**
 * After extraction, persist the (PII-free) dedupe signals and auto-detect duplicates.
 * Returns render options (post-dedupe events + an N-000x resolver) so the freshly-posted
 * card shows any '⚠️ possible duplicate' banner. Advisory: any failure is logged, never
 * thrown — dedupe must never block or lose a need. Zero-copy: the contact is hashed to a
 * blind index; the number itself is never persisted or logged.
 */
async function runDedupeStep(
  needId: string,
  publicId: string,
  projection: ProjectedNeed,
  contact: string | null,
  nowMs: number,
  deps: IntakeJobDeps,
): Promise<CardRenderOptions | undefined> {
  const store = deps.store;
  if (store === undefined) return undefined;
  try {
    const hash = deriveContactHash(contact, deps.contactHashKey);
    const dedupeText = buildDedupeText(projection);
    await store.setDedupeKeys(needId, { contactHash: hash, dedupeText, embedding: null });
    await runDedupe({
      needId,
      publicId,
      type: projection.type,
      localityId: projection.locality_id,
      contactHash: hash,
      dedupeText,
      embedding: null,
      createdAtMs: nowMs,
      store,
      service: deps.service,
      now: nowMs,
    });

    const events = await deps.service.getEvents(needId);
    const otherIds = new Set<string>();
    for (const e of events) {
      if (e.type === 'DuplicateProposed') otherIds.add(e.payload.other_need_id);
    }
    const labels = new Map<string, string>();
    for (const id of otherIds) {
      const pid = await store.getPublicId(id);
      if (pid !== null) labels.set(id, pid);
    }
    return { events, publicIdOf: (id) => labels.get(id) };
  } catch (err) {
    logger.error({ err, need_id: needId, public_id: publicId }, 'intake: dedupe failed (non-fatal)');
    return undefined;
  }
}

/** Process one intake job: create the need (idempotently), extract, and post its card. */
export async function runIntakeJob(
  job: IntakeJob,
  transient: JobTransient | undefined,
  deps: IntakeJobDeps,
): Promise<void> {
  const nowMs = deps.now?.() ?? Date.now();
  const idempotencyKey = needCreatedKey(job.teamId, job.channelId, job.messageTs);

  const outcome = await deps.service.createNeed({
    source: { permalink: job.permalink, channel: job.channelId, ts: job.messageTs, team_id: job.teamId },
    actor: deps.actor ?? INTAKE_ACTOR,
    at: new Date(nowMs).toISOString(),
    idempotencyKey,
    now: nowMs,
    isDemo: deps.isDemo ?? false,
  });

  if (outcome.status === 'deduped') {
    logger.info(
      { need_id: outcome.needId, public_id: outcome.publicId, channel: job.channelId },
      'intake: duplicate message — need already exists, no card',
    );
    return;
  }
  if (outcome.status === 'rejected') {
    logger.warn(
      { code: outcome.code, reason: outcome.reason, channel: job.channelId },
      'intake: need creation rejected',
    );
    return;
  }

  const target = { needId: outcome.needId, publicId: outcome.publicId };
  let projection = outcome.need;
  let contact: string | null = null;

  // Raw text always arrives with the job — inline via the JobTransient, or reconstituted
  // from Slack by the BullMQ worker's TextFetcher (processIntakeJob). Extraction runs
  // whenever text is present; if it is somehow absent (no fetcher wired, or a deleted
  // message → undefined) we skip extraction and post the plain (pre-extraction) card
  // rather than losing the need.
  if (transient?.text !== undefined) {
    // Choose the extractor PER JOB (not at boot) so the live degrade toggle takes effect: a pinned
    // `extractor` wins (tests/demo); otherwise selectExtractor honours the AI-degraded flag —
    // LlmExtractor when an llm is present and the AI is online, else the deterministic heuristic.
    const extractor = deps.extractor ?? selectExtractor({ llm: deps.llm, degraded: getDegrade().llmDisabled });
    try {
      const extracted = await applyExtraction(
        outcome.needId,
        job,
        transient.text,
        nowMs,
        deps,
        extractor,
        outcome.need,
      );
      projection = extracted.projection;
      contact = extracted.contact;
    } catch (err) {
      // A message must never be lost: on any extraction/vault/dispatch failure, fall
      // back to the pre-extraction NEW card so a human still sees the need.
      logger.error(
        { err, need_id: outcome.needId, channel: job.channelId, text_len: transient.text.length },
        'intake: extraction/dispatch failed — posting pre-extraction card (need not lost)',
      );
    }
  }

  // Auto-detect duplicates (advisory) so the card can flag a possible duplicate.
  const cardOpts = await runDedupeStep(outcome.needId, outcome.publicId, projection, contact, nowMs, deps);

  await deps.notifier.postDispatchCard(target, projection, cardOpts);
  logger.info(
    { need_id: outcome.needId, public_id: outcome.publicId, channel: job.channelId, state: projection.state },
    'intake: need created + dispatch card posted',
  );
}

/** Build the queue's job handler. Single-kind for the skeleton; add cases as phases land. */
export function makeIntakeJobHandler(deps: IntakeJobDeps): JobHandler {
  return async (job, transient) => {
    await runIntakeJob(job, transient, deps);
  };
}

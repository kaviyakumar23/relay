import type { Notifier } from '../ingest/notifier';
import { needCreatedKey, needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { Actor, ProjectedNeed } from '../ledger/types';
import { logger } from '../lib/logger';
import type { ContactVault } from '../lib/vault';
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
  /** P-1 extractor (LLM in live mode, deterministic heuristic in tests/demo). */
  extractor: Extractor;
  /** Encrypted contact vault. Undefined = vaulting disabled (dev without a key). */
  vault?: ContactVault;
  /** Clock for the event timestamp + projection (defaults to Date.now). */
  now?: () => number;
  /** Override the creating actor (defaults to the intake agent). */
  actor?: Actor;
  isDemo?: boolean;
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
  fallback: ProjectedNeed,
): Promise<ProjectedNeed> {
  const { payload, contact } = await runExtraction(text, deps.extractor);

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
  return projection;
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

  // Raw text is present in practice; if it is somehow absent we skip extraction and
  // post the plain (pre-extraction) card rather than losing the need.
  if (transient?.text !== undefined) {
    try {
      projection = await applyExtraction(outcome.needId, job, transient.text, nowMs, deps, outcome.need);
    } catch (err) {
      // A message must never be lost: on any extraction/vault/dispatch failure, fall
      // back to the pre-extraction NEW card so a human still sees the need.
      logger.error(
        { err, need_id: outcome.needId, channel: job.channelId, text_len: transient.text.length },
        'intake: extraction/dispatch failed — posting pre-extraction card (need not lost)',
      );
    }
  }

  await deps.notifier.postDispatchCard(target, projection);
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

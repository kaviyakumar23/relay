import type { Notifier } from '../ingest/notifier';
import { needCreatedKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { Actor } from '../ledger/types';
import { logger } from '../lib/logger';
import type { IntakeJob, JobHandler, JobTransient } from './queue';

// The intake worker (BUILD-DOC §16.2 walking skeleton). Turns an IntakeJob into a
// NeedCreated ledger event and a dispatch card. Day-1 it does no extraction: it
// creates a need with default type='other' / severity='low' and posts the dumb
// card. Business-level idempotency comes from needCreatedKey(team,channel,ts) —
// the same Slack message always maps to the same need, even if transport dedupe
// was bypassed (e.g. a retry with a fresh envelope id).

/** NeedCreated is a non-consequential (agent) transition — no human gate. */
const INTAKE_ACTOR: Actor = { type: 'agent', id: 'relay-intake' };

export interface IntakeJobDeps {
  service: NeedService;
  notifier: Notifier;
  /** Clock for the event timestamp + projection (defaults to Date.now). */
  now?: () => number;
  /** Override the creating actor (defaults to the intake agent). */
  actor?: Actor;
  isDemo?: boolean;
}

/**
 * Extraction placeholder (Jul 5 phase). Raw message text may arrive transiently in
 * memory; later phases will run P-1 extraction here. It is NEVER persisted or
 * logged — we record only its length so the memory boundary is observable without
 * leaking a single character of content.
 */
function extractionPlaceholder(text: string | undefined, job: IntakeJob): void {
  logger.debug(
    { channel: job.channelId, ts: job.messageTs, text_len: text?.length ?? 0 },
    'intake: extraction pending (placeholder — text stays in memory, never persisted)',
  );
}

/** Process one intake job: create the need (idempotently) and post its card. */
export async function runIntakeJob(
  job: IntakeJob,
  transient: JobTransient | undefined,
  deps: IntakeJobDeps,
): Promise<void> {
  extractionPlaceholder(transient?.text, job);

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

  if (outcome.status === 'created') {
    await deps.notifier.postDispatchCard({ needId: outcome.needId, publicId: outcome.publicId }, outcome.need);
    logger.info(
      { need_id: outcome.needId, public_id: outcome.publicId, channel: job.channelId },
      'intake: need created + dispatch card posted',
    );
    return;
  }
  if (outcome.status === 'deduped') {
    logger.info(
      { need_id: outcome.needId, public_id: outcome.publicId, channel: job.channelId },
      'intake: duplicate message — need already exists, no card',
    );
    return;
  }
  logger.warn({ code: outcome.code, reason: outcome.reason, channel: job.channelId }, 'intake: need creation rejected');
}

/** Build the queue's job handler. Single-kind for the skeleton; add cases as phases land. */
export function makeIntakeJobHandler(deps: IntakeJobDeps): JobHandler {
  return async (job, transient) => {
    await runIntakeJob(job, transient, deps);
  };
}

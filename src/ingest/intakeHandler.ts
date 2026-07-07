import { logger } from '../lib/logger';
import type { IntakeJob, PipelineQueue } from '../pipeline/queue';
import type { DedupeStore } from './dedupe';

// The intake-message ingress logic, factored out of the Bolt wiring so both the
// live app and the hermetic demo/e2e assembly drive the exact same path:
//   build zero-copy job → enqueue (with text handed transiently to extraction) →
//   record the transport-dedupe key (slack_events) on success.
// This function does NO Slack I/O — the caller (slackApp) has already extracted
// the fields and (best-effort) fetched the permalink.
//
// DEDUPE ORDERING (CLAUDE.md invariant #7): the transport-dedupe layer (slack_events)
// is recorded AFTER a successful enqueue, not before. It is an OPTIMIZATION to skip
// redundant redeliveries — NOT the double-create guard. The real guard is the
// deterministic needCreatedKey business key checked in createNeed (layer 2), which
// collapses any duplicate at the ledger. Recording "seen" before enqueue was a bug: if
// the enqueue then threw (a Redis blip), the event was permanently deduped and Slack's
// retry (same event_id) silently dropped → a lost need. Enqueuing first means a failed
// enqueue leaves the event UNMARKED, so Slack's retry re-processes it. The only cost —
// a successful-enqueue-then-redelivery may enqueue the job twice — is harmless: the
// worker's createNeed dedupes it (returns 'deduped') before any extraction runs.

export interface RawIntake {
  /** Slack envelope event id — stable across redeliveries. The transport dedupe key. */
  eventId: string;
  teamId: string;
  channelId: string;
  messageTs: string;
  userId: string;
  /** Raw message text. Flows transiently to extraction in memory; never persisted. */
  text: string;
  permalink?: string;
}

export interface IntakeDeps {
  queue: PipelineQueue;
  dedupe: DedupeStore;
  /** Only messages in a configured intake channel become needs. */
  isIntakeChannel: (channelId: string) => boolean;
}

export type IntakeOutcome = 'enqueued' | 'skipped_not_intake' | 'skipped_duplicate';

/**
 * Handle one raw intake message: gate on channel role, dedupe the transport
 * delivery, then enqueue the intake job. Returns what happened (for tests + logs).
 */
export async function handleIntakeMessage(raw: RawIntake, deps: IntakeDeps): Promise<IntakeOutcome> {
  if (!deps.isIntakeChannel(raw.channelId)) return 'skipped_not_intake';

  const job: IntakeJob = {
    kind: 'intake',
    teamId: raw.teamId,
    channelId: raw.channelId,
    messageTs: raw.messageTs,
    permalink: raw.permalink,
    userId: raw.userId,
  };
  // Enqueue FIRST (see DEDUPE ORDERING above). Text rides along transiently (in-memory
  // only) so later extraction can consume it. A throw here propagates uncaught so the
  // event stays UNMARKED and Slack's retry re-processes it — a need is never lost.
  await deps.queue.enqueue(job, { text: raw.text });

  // Then record the transport-dedupe key. On the first delivery this is fresh → enqueued;
  // a redelivery finds it already seen → skipped_duplicate (the redundant enqueue above is
  // collapsed at createNeed's needCreatedKey, so no second need/card results).
  const fresh = await deps.dedupe.markSeen(raw.eventId);
  if (!fresh) {
    logger.debug(
      { event_id: raw.eventId, channel: raw.channelId },
      'intake: duplicate delivery (transport dedupe, post-enqueue)',
    );
    return 'skipped_duplicate';
  }
  return 'enqueued';
}

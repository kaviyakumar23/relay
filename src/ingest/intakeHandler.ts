import { logger } from '../lib/logger';
import type { IntakeJob, PipelineQueue } from '../pipeline/queue';
import type { DedupeStore } from './dedupe';

// The intake-message ingress logic, factored out of the Bolt wiring so both the
// live app and the hermetic demo/e2e assembly drive the exact same path:
//   transport dedupe (slack_events) → build zero-copy job → enqueue (with text
//   handed transiently to the extraction step).
// This function does NO Slack I/O — the caller (slackApp) has already extracted
// the fields and (best-effort) fetched the permalink.

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

  const fresh = await deps.dedupe.markSeen(raw.eventId);
  if (!fresh) {
    logger.debug(
      { event_id: raw.eventId, channel: raw.channelId },
      'intake: duplicate delivery skipped (transport dedupe)',
    );
    return 'skipped_duplicate';
  }

  const job: IntakeJob = {
    kind: 'intake',
    teamId: raw.teamId,
    channelId: raw.channelId,
    messageTs: raw.messageTs,
    permalink: raw.permalink,
    userId: raw.userId,
  };
  // Text rides along transiently (in-memory only) so later extraction can consume it.
  await deps.queue.enqueue(job, { text: raw.text });
  return 'enqueued';
}

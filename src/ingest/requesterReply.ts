import type { ProjectedNeed } from '../ledger/types';
import { logger } from '../lib/logger';
import { buildRequesterReply, type RequesterReplyKind } from '../surfaces/requesterReplies';
import type { Notifier } from './notifier';

// The integrator seam for Moonshot #4 (close the loop with the requester). As a need
// progresses — assigned → en-route → delivered → verified — Relay posts a calm, language-matched
// reply back into the REQUESTER's OWN message thread (the source channel + thread_ts carried on
// the need's projection). This is a COURTESY notification, never a consequential transition:
// a missing source or a failed post is logged and swallowed so it can never break a state handler.
//
// The reply text comes from the pure builder (surfaces/requesterReplies) — bilingual (Tamil then
// English) iff the need's languages include 'ta', English-only otherwise, carrying ONLY the
// volunteer's first name + the public id (invariant #5). Shared by the live Slack handlers
// (src/ingest/slackApp) and the hermetic demo driver so both drive the exact same seam.

export interface RequesterReplyInput {
  notifier: Notifier;
  /** The need whose SOURCE thread receives the reply (source.channel + source.ts). */
  need: ProjectedNeed;
  kind: RequesterReplyKind;
  /** The assigned volunteer's display name (only the first token is ever shown). */
  volunteerName?: string;
  /** Reported ETA in minutes (en_route only). */
  etaMinutes?: number | null;
  /** The need's public id (N-000x) — the only reference identifier shown to the requester. */
  publicId: string;
}

/**
 * Best-effort: post a requester-facing progress reply into the need's SOURCE thread. Returns
 * true when a reply was posted, false when there was no usable source thread or the post failed.
 * NEVER throws — a courtesy notification must never break a state transition.
 */
export async function postRequesterReply(input: RequesterReplyInput): Promise<boolean> {
  const { notifier, need, kind } = input;
  const channel = need.source.channel;
  const threadTs = need.source.ts;
  if (channel === undefined || channel === '' || threadTs === undefined || threadTs === '') return false;
  try {
    const { text } = buildRequesterReply(kind, {
      languages: need.languages,
      volunteerName: input.volunteerName,
      etaMinutes: input.etaMinutes,
      publicId: input.publicId,
    });
    await notifier.postToChannel(channel, text, [], threadTs);
    return true;
  } catch (err) {
    logger.debug({ err, need_id: need.need_id, kind }, 'requester reply post failed (non-fatal)');
    return false;
  }
}

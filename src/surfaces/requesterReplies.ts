import { escapeMrkdwn } from './primitives';

// Requester-facing replies (Moonshot #4 — close the loop with the person in need).
// As a need progresses — assigned → en-route → delivered → verified — Relay posts a
// calm, warm, language-matched reply back into the REQUESTER's own message thread, so
// the person who asked for help actually benefits from the structure behind the scenes.
//
// This is the OUTPUT direction of Relay's Tamil/English code-mix: if the need was
// reported in Tamil, the reply leads with a natural Tamil line, then an English line.
//
// PII discipline (invariant #5): the reply carries ONLY the volunteer's FIRST name and
// the need's public id (N-000x). No phone, no beneficiary name, no address, no message
// content — nothing that isn't already safe to show. The volunteer's display name is
// reduced to its first token before rendering, and every interpolated value is escaped.
//
// Pure over its inputs — no Slack client, no store, no clock — so it is unit-testable and
// the integrator can post the returned `text` from any event handler.
//
// --- Integrator seam --------------------------------------------------------------
// Post buildRequesterReply(kind, ctx).text into the need's SOURCE thread — the original
// requester message — best-effort:
//   • source channel + thread_ts come from the NeedCreated event's payload.source
//     ({ channel, ts }). NOTE: ProjectedNeed.source carries these (projection copies
//     head.payload.source), so a handler can read them off the projection; if a handler
//     only has the event stream, thread them from the NeedCreated event directly.
//   • kind mapping (which event fires which reply):
//       Assigned                                   → 'assigned'
//       EnRouteReported                            → 'en_route'   (payload.eta_minutes → ctx.etaMinutes)
//       EvidenceAttached / DELIVERED_UNVERIFIED    → 'delivered'
//       Verified / Closed                          → 'verified'
//   • ctx.languages = projection.languages; ctx.volunteerName = the assigned volunteer's
//     display_name (first name is extracted here); ctx.publicId = the N-000x label.
//   • Wrap the post in try/catch and log-and-continue: a missing source (source.channel /
//     source.ts absent) or a failed post must NEVER break the state handler. This is a
//     courtesy notification, not a consequential transition.
//   • notifier.postToChannel currently has NO thread_ts param — it is
//     postToChannel(channel, text, blocks). To thread the reply under the original
//     message, the integrator must add an optional `threadTs?: string` argument to
//     postToChannel (SlackNotifier passes it through to chat.postMessage.thread_ts —
//     the SlackClientLike.postMessage type already accepts thread_ts — and
//     RecordingNotifier records it). The reply is text-only (blocks: []).

export type RequesterReplyKind = 'assigned' | 'en_route' | 'delivered' | 'verified';

export interface RequesterReplyContext {
  /** The need's detected languages (from extraction / projection). 'ta' present → bilingual. */
  languages: string[];
  /** The assigned volunteer's display name. Only the FIRST token is ever shown. */
  volunteerName?: string;
  /** Reported ETA in minutes (en_route only). Ignored unless a positive finite number. */
  etaMinutes?: number | null;
  /** The need's public id (N-000x) — the only reference identifier shown to the requester. */
  publicId: string;
}

/** Reduce a display name to its first token (PII minimisation) and neutralise mrkdwn.
 * Returns null when there is no usable name so callers fall back to "a volunteer". */
function firstName(name?: string): string | null {
  const first = (name ?? '').trim().split(/\s+/)[0];
  return first ? escapeMrkdwn(first) : null;
}

/** True when Tamil is among the need's languages (tolerant of case / stray whitespace). */
function isTamil(languages: string[]): boolean {
  return languages.some((l) => l.trim().toLowerCase() === 'ta');
}

/** A positive, finite ETA in whole minutes, or null when none was reported. */
function usableEta(etaMinutes?: number | null): number | null {
  return typeof etaMinutes === 'number' && Number.isFinite(etaMinutes) && etaMinutes > 0
    ? Math.round(etaMinutes)
    : null;
}

/** A bilingual line pair — Tamil first, then English. Tamil is omitted for en-only needs. */
interface LinePair {
  ta: string;
  en: string;
}

/** Build the Tamil + English lines for a given progress kind. `name` is already first-only
 * and escaped; the *word* for an unknown volunteer differs per language. */
function linesFor(kind: RequesterReplyKind, name: string | null, eta: number | null): LinePair {
  const taWho = name ?? 'ஒரு தன்னார்வலர்';
  const enWho = name ?? 'a volunteer';
  switch (kind) {
    case 'assigned':
      return {
        ta: `உதவி வருகிறது — ${taWho} உங்களை நோக்கி வருகிறார்.`,
        en: `Help is on the way — ${enWho} is heading to you.`,
      };
    case 'en_route':
      if (eta !== null) {
        const mins = `${eta} minute${eta === 1 ? '' : 's'}`;
        return {
          ta: `உதவி வழியில் உள்ளது — ${taWho} சுமார் ${eta} நிமிடத்தில் வந்துவிடுவார்.`,
          en: `On the way — ${enWho} should reach you in about ${mins}.`,
        };
      }
      return {
        ta: `உதவி வழியில் உள்ளது — ${taWho} உங்களை நோக்கி வந்துகொண்டிருக்கிறார்.`,
        en: `On the way — ${enWho} is heading to you now.`,
      };
    case 'delivered':
      return {
        ta: 'உதவி வழங்கப்பட்டது ✅ விரைவில் உறுதிசெய்யப்படும்.',
        en: "Your request has been delivered. We'll confirm shortly.",
      };
    case 'verified':
      return {
        ta: 'உங்கள் உறுதிப்படுத்தல் பெறப்பட்டது ✅ உதவி முடிந்தது — நன்றி.',
        en: "Thank you — we've received your confirmation and closed this request.",
      };
  }
}

/**
 * Build the requester-facing reply for a progress `kind`. Returns `{ text }` only (posted as
 * a threaded message, no blocks). Bilingual (Tamil line, then English line) when the need's
 * languages include 'ta'; English-only otherwise. A trailing `Ref: N-000x` lets the requester
 * and coordinators correlate without exposing any PII.
 */
export function buildRequesterReply(kind: RequesterReplyKind, ctx: RequesterReplyContext): { text: string } {
  const { ta, en } = linesFor(kind, firstName(ctx.volunteerName), usableEta(ctx.etaMinutes));
  const body = isTamil(ctx.languages) ? `${ta}\n${en}` : en;
  return { text: `${body}\n\nRef: ${escapeMrkdwn(ctx.publicId)}` };
}

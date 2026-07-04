// Deterministic idempotency keys (kept pattern): the same real-world happening
// always maps to the same key, and need_events.idempotency_key is UNIQUE — so
// Slack retries, worker restarts, and double-clicks append at most once.
// Keys are structural, never random. Never build one from message content.

/** A Slack message becoming a Need — keyed by its unique (team, channel, ts). */
export function needCreatedKey(teamId: string, channelId: string, messageTs: string): string {
  return `slack:${teamId}:${channelId}:${messageTs}:need_created`;
}

/** A lifecycle event on a need, discriminated by what makes this occurrence unique
 * (e.g. an action_ts for a button click, an obligation id for a claim). */
export function needEventKey(needId: string, eventType: string, discriminator: string): string {
  return `need:${needId}:${eventType}:${discriminator}`;
}

/** Scheduled work (nudges, sweeps) — keyed by state version so a re-fire after
 * the state advanced gets a fresh key while true duplicates collide. */
export function timerEventKey(obligationId: string, kind: string, stateVersion: number): string {
  return `timer:${obligationId}:${kind}:${stateVersion}`;
}

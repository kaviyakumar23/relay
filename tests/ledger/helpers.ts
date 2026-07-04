import type { EventBody, NeedEvent } from '../../src/ledger/events';
import type { Actor } from '../../src/ledger/types';

// Hermetic test helpers — deterministic actors, event builder, and a fixed clock.

export const human = (id = 'U_COORD'): Actor => ({ type: 'human', id });
export const agent = (id = 'relay-bot'): Actor => ({ type: 'agent', id });
export const system = (id = 'drift-engine'): Actor => ({ type: 'system', id });

let seq = 0;

/** Build a durable NeedEvent envelope + body for projection/state-machine tests. */
export function ev(needId: string, at: string, actor: Actor, body: EventBody, key?: string): NeedEvent {
  seq += 1;
  return {
    event_id: `evt_test_${seq}`,
    need_id: needId,
    at,
    actor,
    idempotency_key: key ?? `k_${seq}`,
    ...body,
  } as NeedEvent;
}

/** A monotonically increasing ISO clock so successive events have ordered `at`. */
export function isoClock(startMs = Date.parse('2026-07-04T00:00:00.000Z'), stepMs = 1000): () => string {
  let t = startMs;
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}

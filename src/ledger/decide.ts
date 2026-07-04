import { randomUUID } from 'node:crypto';
import { assertNoRawContent, type Command, type NeedEvent, validateCommand } from './events';
import { project } from './projection';
import { canApply, HUMAN_GATES } from './stateMachine';
import type { Actor } from './types';

// decide() is the deterministic heart of the engine (kept DNA). Given the current
// event log and a proposed Command, it returns exactly one outcome:
//   • emit       — valid; here are the events to append
//   • suppressed — idempotent no-op (the key was already applied)
//   • rejected   — a guard refused (invalid envelope/payload, illegal transition,
//                  human gate, insufficient evidence, or a zero-copy violation)
// It performs NO I/O. Pure (events, command, ctx) → Decision, so it is exhaustively
// unit-testable and replay-safe.

export interface DecideContext {
  needId: string;
  actor: Actor;
  at: string; // ISO timestamp
  idempotencyKey: string;
  /** Reference "now" for time-derived projection flags. */
  now?: number;
}

export type Decision =
  | { outcome: 'emit'; events: NeedEvent[] }
  | { outcome: 'suppressed'; reason: string }
  | { outcome: 'rejected'; code: string; reason: string };

const newEventId = (): string => `evt_${randomUUID()}`;

const blank = (s: unknown): boolean => typeof s !== 'string' || s.trim() === '';

export function decide(events: NeedEvent[], command: Command, ctx: DecideContext): Decision {
  // Envelope provenance (auditability) — every event must carry it.
  if (
    !ctx.actor ||
    blank(ctx.actor.type) ||
    blank(ctx.actor.id) ||
    blank(ctx.needId) ||
    blank(ctx.at) ||
    blank(ctx.idempotencyKey)
  ) {
    return {
      outcome: 'rejected',
      code: 'INVALID_ENVELOPE',
      reason: 'actor{type,id}, needId, at, and idempotencyKey are required (non-blank) for an auditable event',
    };
  }

  // Command payload boundary validation (invariant #3 — Zod at every boundary).
  const parsed = validateCommand(command);
  if (!parsed.ok) return { outcome: 'rejected', code: 'INVALID_PAYLOAD', reason: parsed.message };

  // Idempotency: an already-applied key is a no-op, not an error.
  if (events.some((e) => e.idempotency_key === ctx.idempotencyKey)) {
    return { outcome: 'suppressed', reason: `idempotency key already applied: ${ctx.idempotencyKey}` };
  }

  const current = events.length > 0 ? project(events, { now: ctx.now }) : null;

  const event = {
    event_id: newEventId(),
    need_id: ctx.needId,
    at: ctx.at,
    actor: ctx.actor,
    idempotency_key: ctx.idempotencyKey,
    ...parsed.command,
  } as NeedEvent;

  // Zero-copy: never let raw content into the durable log (invariant #5).
  assertNoRawContent(event);

  // Human gate (§6.2): consequential transitions require a human actor event.
  // Enforced HERE, in the engine — never trusted to the caller.
  if (HUMAN_GATES.has(event.type) && ctx.actor.type !== 'human') {
    return {
      outcome: 'rejected',
      code: 'HUMAN_GATE',
      reason: `${event.type} is a consequential transition and requires a human actor (got ${ctx.actor.type})`,
    };
  }

  // Structural guard: state legality + evidence sufficiency.
  const guard = canApply(current, event);
  if (!guard.ok) return { outcome: 'rejected', code: guard.code, reason: guard.message };

  return { outcome: 'emit', events: [event] };
}

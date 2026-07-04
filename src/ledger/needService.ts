import { randomUUID } from 'node:crypto';
import { type DecideContext, decide } from './decide';
import type { Command, NeedEvent } from './events';
import { project, toProjectionCache } from './projection';
import { ConcurrencyError } from './store/errors';
import type { EventStore, NeedInit } from './store/eventStore';
import type { Actor, ConfidenceStatus, NeedSource, NeedType, ProjectedNeed, Severity } from './types';

// The seam every adapter (Slack handlers, pipeline workers, drift engine, the demo
// runner) uses. It wires the append-only store and the pure decision engine into:
//   propose command → engine decides → events appended → fresh projection returned.
// It is the ONLY code that writes needs.status (the projection cache): after every
// successful append it re-projects and updates the cache.

export interface CreateNeedInput {
  source: NeedSource;
  actor: Actor;
  at: string; // ISO
  idempotencyKey: string;
  isDemo?: boolean;
  now?: number;
  // Optional pre-extraction overrides (walking-skeleton defaults: other / low).
  type?: NeedType;
  severity?: Severity;
  localityId?: number | null;
  locationText?: string | null;
  peopleCount?: number | null;
  languages?: string[];
  confidence?: Record<string, ConfidenceStatus>;
}

export type CreateNeedOutcome =
  | { status: 'created'; needId: string; publicId: string; need: ProjectedNeed; events: NeedEvent[] }
  | { status: 'deduped'; needId: string; publicId: string; reason: string }
  | { status: 'rejected'; code: string; reason: string };

export interface DispatchContext {
  actor: Actor;
  at: string; // ISO
  idempotencyKey: string;
  now?: number;
}

export interface DispatchResult {
  status: 'applied' | 'suppressed' | 'rejected' | 'conflict';
  need?: ProjectedNeed;
  events?: NeedEvent[];
  reason?: string;
  code?: string;
}

/** Max optimistic-concurrency retries before surfacing a conflict. */
const MAX_DISPATCH_ATTEMPTS = 4;

const newNeedId = (): string => randomUUID();

export class NeedService {
  constructor(
    private readonly store: EventStore,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /**
   * Intake a new need: decide the NeedCreated event, then atomically create the
   * needs row + append the event (FK ordering), then cache the projection. Idempotent
   * on idempotencyKey — a duplicate returns the existing need without a second row.
   */
  async createNeed(input: CreateNeedInput): Promise<CreateNeedOutcome> {
    const now = input.now ?? this.clock();
    const needId = newNeedId();
    const command: Command = {
      type: 'NeedCreated',
      payload: { source: input.source, ...(input.isDemo ? { is_demo: true } : {}) },
    };
    const ctx: DecideContext = {
      needId,
      actor: input.actor,
      at: input.at,
      idempotencyKey: input.idempotencyKey,
      now,
    };

    const decision = decide([], command, ctx);
    if (decision.outcome === 'rejected') return { status: 'rejected', code: decision.code, reason: decision.reason };
    if (decision.outcome === 'suppressed') return { status: 'rejected', code: 'SUPPRESSED', reason: decision.reason };

    const firstEvent = decision.events[0];
    if (!firstEvent)
      return { status: 'rejected', code: 'ENGINE_ERROR', reason: 'engine emitted no event for NeedCreated' };
    const init: NeedInit = {
      needId,
      type: input.type ?? 'other',
      severity: input.severity ?? 'low',
      localityId: input.localityId ?? null,
      locationText: input.locationText ?? null,
      peopleCount: input.peopleCount ?? null,
      languages: input.languages ?? [],
      sourcePermalink: input.source.permalink ?? null,
      confidence: input.confidence ?? {},
      isDemo: input.isDemo ?? false,
    };

    const res = await this.store.createNeed(init, firstEvent);
    if (!res.created) {
      return {
        status: 'deduped',
        needId: res.needId,
        publicId: res.publicId,
        reason: 'idempotent: need already created',
      };
    }

    const need = await this.syncCache(res.needId, now);
    return { status: 'created', needId: res.needId, publicId: res.publicId, need, events: [firstEvent] };
  }

  /**
   * Apply a proposed command: idempotency → engine decides → compare-and-append →
   * re-project + cache. Optimistic concurrency: if a different command advanced the
   * need between our read and our write, re-read → re-decide → retry, so concurrent
   * writers serialize by causality instead of clobbering state.
   */
  async dispatch(needId: string, command: Command, ctx: DispatchContext): Promise<DispatchResult> {
    const now = ctx.now ?? this.clock();

    if (await this.store.hasIdempotencyKey(ctx.idempotencyKey)) {
      return { status: 'suppressed', reason: `idempotency key already applied: ${ctx.idempotencyKey}` };
    }

    for (let attempt = 1; attempt <= MAX_DISPATCH_ATTEMPTS; attempt++) {
      const events = await this.store.getEvents(needId);
      const decision = decide(events, command, {
        needId,
        actor: ctx.actor,
        at: ctx.at,
        idempotencyKey: ctx.idempotencyKey,
        now,
      });

      if (decision.outcome === 'suppressed') return { status: 'suppressed', reason: decision.reason };
      if (decision.outcome === 'rejected') return { status: 'rejected', code: decision.code, reason: decision.reason };

      try {
        const persisted = await this.store.append(decision.events, { expectedVersion: events.length });
        // A concurrent caller with the same key won the race → the store deduped ours.
        // Surfacing 'suppressed' (not 'applied') prevents adapters double-firing side effects.
        if (persisted.length === 0) return { status: 'suppressed', reason: 'idempotent: event already applied' };
        const need = await this.syncCache(needId, now);
        return { status: 'applied', need, events: persisted };
      } catch (err) {
        if (err instanceof ConcurrencyError) continue; // a different writer advanced us → re-read + re-decide
        throw err;
      }
    }
    return {
      status: 'conflict',
      reason: `concurrent modification of ${needId} (after ${MAX_DISPATCH_ATTEMPTS} attempts)`,
    };
  }

  async getNeed(needId: string, now?: number): Promise<ProjectedNeed | null> {
    const events = await this.store.getEvents(needId);
    if (events.length === 0) return null;
    return project(events, { now: now ?? this.clock() });
  }

  async getEvents(needId: string): Promise<NeedEvent[]> {
    return this.store.getEvents(needId);
  }

  async listNeeds(now?: number): Promise<ProjectedNeed[]> {
    const ref = now ?? this.clock();
    const ids = await this.store.getAllNeedIds();
    const out: ProjectedNeed[] = [];
    for (const id of ids) {
      const events = await this.store.getEvents(id);
      if (events.length > 0) out.push(project(events, { now: ref }));
    }
    return out;
  }

  /** Re-project from the log and write the needs-row cache (the only status writer). */
  private async syncCache(needId: string, now: number): Promise<ProjectedNeed> {
    const need = project(await this.store.getEvents(needId), { now });
    await this.store.updateProjectionCache(needId, toProjectionCache(need));
    return need;
  }
}

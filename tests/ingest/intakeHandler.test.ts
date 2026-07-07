import { describe, expect, it } from 'vitest';
import { MemoryDedupeStore } from '../../src/ingest/dedupe';
import { handleIntakeMessage, type RawIntake } from '../../src/ingest/intakeHandler';
import type { IntakeJob, JobTransient, PipelineQueue } from '../../src/pipeline/queue';

// handleIntakeMessage records the transport-dedupe key AFTER a successful enqueue, not
// before. These lock the ordering fix: a failed enqueue must NOT permanently dedupe the
// event, or Slack's retry (same event_id) is dropped and the need is lost. Transport
// dedupe is an optimization; the real double-create guard is needCreatedKey at createNeed.

const RAW: RawIntake = {
  eventId: 'Ev01',
  teamId: 'T1',
  channelId: 'C_INTAKE',
  messageTs: '1720051200.000111',
  userId: 'U1',
  text: 'Family trapped in Velachery',
};

/** A queue whose enqueue fails the first N calls, recording each job + transient. */
function flakyQueue(failFirst: number): {
  queue: PipelineQueue;
  calls: Array<{ job: IntakeJob; transient?: JobTransient }>;
} {
  const calls: Array<{ job: IntakeJob; transient?: JobTransient }> = [];
  let n = 0;
  const queue: PipelineQueue = {
    enqueue: async (job, transient) => {
      n += 1;
      calls.push({ job: job as IntakeJob, transient });
      if (n <= failFirst) throw new Error('redis blip');
    },
  };
  return { queue, calls };
}

const deps = (queue: PipelineQueue, dedupe: MemoryDedupeStore) => ({
  queue,
  dedupe,
  isIntakeChannel: (id: string) => id === 'C_INTAKE',
});

describe('handleIntakeMessage — dedupe ordering (enqueue before markSeen)', () => {
  it('a failing enqueue does NOT mark the event seen; the Slack retry re-processes it', async () => {
    const dedupe = new MemoryDedupeStore();
    const { queue } = flakyQueue(1); // first enqueue throws, then succeeds

    // Delivery 1: enqueue throws → propagates uncaught (Slack will retry).
    await expect(handleIntakeMessage(RAW, deps(queue, dedupe))).rejects.toThrow('redis blip');

    // Delivery 2 (Slack retry, SAME event_id): enqueue now succeeds → 'enqueued'. This only
    // happens if delivery 1 left the event UNMARKED — the whole point of the ordering fix.
    expect(await handleIntakeMessage(RAW, deps(queue, dedupe))).toBe('enqueued');

    // Delivery 3 (a genuine redelivery after success): enqueued again (redundant), but the
    // transport key is now seen → skipped_duplicate. The redundant enqueue is harmless — the
    // worker's createNeed collapses it at needCreatedKey before any extraction.
    expect(await handleIntakeMessage(RAW, deps(queue, dedupe))).toBe('skipped_duplicate');
  });

  it('the happy path enqueues then marks seen; the text rides transiently to extraction', async () => {
    const dedupe = new MemoryDedupeStore();
    const { queue, calls } = flakyQueue(0);

    expect(await handleIntakeMessage(RAW, deps(queue, dedupe))).toBe('enqueued');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.job.kind).toBe('intake');
    expect(calls[0]?.job.messageTs).toBe(RAW.messageTs);
    expect(calls[0]?.transient).toEqual({ text: RAW.text }); // zero-copy transient sidecar
    // The event is now recorded → a later redelivery is a duplicate.
    expect(await dedupe.markSeen(RAW.eventId)).toBe(false);
  });

  it('a non-intake channel is skipped before any enqueue or dedupe write', async () => {
    const dedupe = new MemoryDedupeStore();
    const { queue, calls } = flakyQueue(0);

    const outcome = await handleIntakeMessage({ ...RAW, channelId: 'C_OTHER' }, deps(queue, dedupe));

    expect(outcome).toBe('skipped_not_intake');
    expect(calls).toHaveLength(0);
    expect(await dedupe.markSeen(RAW.eventId)).toBe(true); // untouched
  });
});

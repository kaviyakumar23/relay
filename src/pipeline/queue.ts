import { type Job, Queue, Worker } from 'bullmq';

// The pipeline queue seam (BUILD-DOC §9.1 pipeline/, §9.2 rule 1 "ack fast, work
// async"). Slack handlers ack immediately and enqueue; workers do the slow work.
// Two adapters:
//   • InlineQueue  — runs the handler in-process, immediately (hermetic tests + demo).
//   • BullMQQueue  — durable Redis-backed queue + worker (live mode).
//
// ZERO-COPY BOUNDARY (invariant #5): the durable job payload (PipelineJob) carries
// only Slack object references — team/channel/ts/permalink/user — NEVER the raw
// message text. Text may still flow to the extraction step through memory (see
// JobTransient), but it must never cross a persistence boundary: not into Redis,
// not into ledger rows, not into logs.

/** An intake message that must become a Need. No message text — zero-copy. */
export interface IntakeJob {
  kind: 'intake';
  teamId: string;
  channelId: string;
  messageTs: string;
  permalink?: string;
  userId: string;
}

/** The durable job union (extensible: extraction/dedupe/geocode jobs land later). */
export type PipelineJob = IntakeJob;

/**
 * In-memory-only sidecar handed alongside a job to the extraction step. NEVER
 * serialized (no Redis, no rows, no logs). This is the one channel by which raw
 * message text may reach later phases in-process; the durable PipelineJob stays
 * clean. BullMQ deliberately drops it at the Redis boundary — a distributed worker
 * re-fetches text from Slack (conversations.history) at processing time instead.
 */
export interface JobTransient {
  text?: string;
}

export type JobHandler = (job: PipelineJob, transient?: JobTransient) => Promise<void>;

export interface PipelineQueue {
  enqueue(job: PipelineJob, transient?: JobTransient): Promise<void>;
}

/**
 * Hermetic adapter: runs the handler inline, in-process, immediately. Used by the
 * test suite and `npm run demo` (no Redis). Transient text flows straight through
 * to the handler in memory — exactly the boundary we document above.
 */
export class InlineQueue implements PipelineQueue {
  constructor(private readonly handler: JobHandler) {}

  async enqueue(job: PipelineJob, transient?: JobTransient): Promise<void> {
    await this.handler(job, transient);
  }
}

export interface BullMQQueueOpts {
  redisUrl: string;
  handler: JobHandler;
  queueName?: string;
}

/** ioredis connection options derived from a redis:// URL. maxRetriesPerRequest:null
 * is BullMQ's required setting for blocking worker connections. */
function connectionFromUrl(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
} {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username || undefined,
    password: u.password || undefined,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

/**
 * Durable adapter on BullMQ. The Queue/Worker are created LAZILY (on first enqueue /
 * when the worker starts) — never at import time — so importing this module in a
 * hermetic test or the demo opens no sockets. BullMQ owns the ioredis connections
 * (created from URL options), which sidesteps the bundled-ioredis type clash and is
 * closed by queue/worker .close(). The worker receives only the durable PipelineJob;
 * the transient text sidecar is intentionally not reconstituted here.
 */
export class BullMQQueue implements PipelineQueue {
  private readonly queueName: string;
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly opts: BullMQQueueOpts) {
    this.queueName = opts.queueName ?? 'relay:pipeline';
  }

  private ensureQueue(): Queue {
    const q = this.queue ?? new Queue(this.queueName, { connection: connectionFromUrl(this.opts.redisUrl) });
    this.queue = q;
    return q;
  }

  async enqueue(job: PipelineJob): Promise<void> {
    await this.ensureQueue().add(job.kind, job, { removeOnComplete: true, removeOnFail: 100 });
  }

  /** Register the worker that drains the queue. Call once at boot. */
  startWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      this.queueName,
      async (job: Job) => {
        await this.opts.handler(job.data as PipelineJob);
      },
      { connection: connectionFromUrl(this.opts.redisUrl) },
    );
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }
}

import { type Job, Queue, Worker } from 'bullmq';
import type { TextFetcher } from './textFetcher';

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
//
// The two adapters MUST produce the same extraction. InlineQueue passes the transient
// text straight through in-process. BullMQ drops the transient at the Redis boundary,
// so its worker RE-FETCHES the single message text from Slack (an injected TextFetcher)
// just before calling the handler — reconstituting the same JobTransient the inline path
// hands through. The shared per-job logic lives in `processIntakeJob` so both paths, and
// tests, exercise one code path.

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
 * clean. BullMQ deliberately drops it at the Redis boundary — the worker re-fetches
 * text from Slack (conversations.history, via TextFetcher) at processing time and
 * rebuilds this sidecar in `processIntakeJob` instead.
 */
export interface JobTransient {
  text?: string;
}

export type JobHandler = (job: PipelineJob, transient?: JobTransient) => Promise<void>;

export interface PipelineQueue {
  enqueue(job: PipelineJob, transient?: JobTransient): Promise<void>;
}

/** Dependencies for processing one durable job: the handler plus (for durable adapters
 * that dropped the transient) a TextFetcher to reconstitute the message text. */
export interface ProcessJobDeps {
  handler: JobHandler;
  /** Reconstitutes the transient text from Slack. Undefined = run the handler with no
   * text (the pre-extraction card fallback) rather than losing the need. */
  textFetcher?: TextFetcher;
}

/**
 * The shared per-job pipeline step, factored out so BullMQ's worker and (potentially)
 * any other adapter produce IDENTICAL extraction. For an intake job it reconstitutes
 * the raw message text via the injected TextFetcher — zero-copy (invariant #5): the text
 * is fetched on demand from Slack, never read from Redis/a row/a log — and hands it to
 * the handler through the in-memory transient. With no fetcher (or a message that can no
 * longer be read → undefined) the handler still runs and posts the pre-extraction card.
 */
export async function processIntakeJob(job: PipelineJob, deps: ProcessJobDeps): Promise<void> {
  const text = job.kind === 'intake' ? await deps.textFetcher?.fetchText(job.channelId, job.messageTs) : undefined;
  await deps.handler(job, { text });
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
  /** Reconstitutes the transient message text in the worker before the handler runs, so
   * the durable path extracts identically to InlineQueue. The integrator wires a concrete
   * SlackTextFetcher(webClient) here (src/server.ts); without it extraction is skipped and
   * the worker posts the pre-extraction card. */
  textFetcher?: TextFetcher;
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
 * closed by queue/worker .close(). The worker reconstitutes the transient message text
 * via the injected TextFetcher (in `processIntakeJob`) BEFORE calling the handler, so the
 * durable path produces the SAME extraction as InlineQueue. Jobs retry with backoff
 * (attempts:3) so a transient worker error re-runs instead of silently dropping a need.
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
    // Retry with exponential backoff: a transient worker/Slack/DB blip must re-run, never
    // silently drop a need (the review flagged the old attempts:1). Redeliveries collapse
    // at the deterministic needCreatedKey business key, so retries are safe to re-process.
    await this.ensureQueue().add(job.kind, job, {
      removeOnComplete: true,
      removeOnFail: 100,
      attempts: 3,
      backoff: { type: 'exponential', delay: 1000 },
    });
  }

  /** Register the worker that drains the queue. Call once at boot. */
  startWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      this.queueName,
      async (job: Job) => {
        // Reconstitute the transient text (TextFetcher) then run the shared step, so the
        // durable path extracts identically to InlineQueue.
        await processIntakeJob(job.data as PipelineJob, {
          handler: this.opts.handler,
          textFetcher: this.opts.textFetcher,
        });
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

import { type Job, Queue, Worker } from 'bullmq';
import { logger } from '../../lib/logger';
import type { DriftSweep, Scheduler } from './scheduler';

// Durable drift scheduler on Redis + BullMQ (live mode). A single REPEATABLE job
// fires every `everyMs` (default 60s per §F4) and calls sweep(Date.now()). The
// Queue/Worker are created LAZILY in start() — never at import time — so importing
// this module in a hermetic test or the demo opens no sockets. BullMQ owns the
// ioredis connection (built from URL options), which sidesteps the bundled-ioredis
// type clash and is closed by queue/worker .close() (same pattern as
// src/pipeline/queue.ts). This adapter is NOT exercised by hermetic tests — the
// in-memory scheduler + a virtual clock cover the sweep logic deterministically.

const QUEUE_NAME = 'relay:drift';
const SWEEP_JOB = 'drift-sweep';
const DEFAULT_EVERY_MS = 60_000;

/** ioredis connection options from a redis:// URL. maxRetriesPerRequest:null is
 * BullMQ's required setting for blocking worker connections. */
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

export interface BullmqSchedulerOpts {
  redisUrl: string;
  /** Tick interval in ms (default 60_000). */
  everyMs?: number;
  queueName?: string;
}

export class BullmqScheduler implements Scheduler {
  private readonly redisUrl: string;
  private readonly everyMs: number;
  private readonly queueName: string;
  private queue?: Queue;
  private worker?: Worker;

  constructor(opts: BullmqSchedulerOpts) {
    this.redisUrl = opts.redisUrl;
    this.everyMs = opts.everyMs ?? DEFAULT_EVERY_MS;
    this.queueName = opts.queueName ?? QUEUE_NAME;
  }

  start(sweep: DriftSweep): void {
    const queue = new Queue(this.queueName, { connection: connectionFromUrl(this.redisUrl) });
    this.queue = queue;
    this.worker = new Worker(
      this.queueName,
      async (_job: Job) => {
        await sweep(Date.now());
      },
      { connection: connectionFromUrl(this.redisUrl) },
    );
    // One repeatable job drives the tick. BullMQ dedupes repeatables by (name +
    // repeat opts), so re-adding on restart replaces rather than duplicates.
    queue
      .add(SWEEP_JOB, {}, { repeat: { every: this.everyMs }, removeOnComplete: true, removeOnFail: false })
      .catch((err) => logger.error({ err }, 'drift scheduler: failed to register repeatable sweep'));
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
    this.worker = undefined;
    this.queue = undefined;
  }
}

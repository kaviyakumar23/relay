import { readFileSync } from 'node:fs';
import { WebClient } from '@slack/web-api';
import Redis from 'ioredis';
import pg from 'pg';
import { parseScenario, type Scenario } from '../demo/scenarios/schema';
import { config } from './config';
import { InMemoryDemoResetStore, PgDemoResetStore } from './demo/reset';
import { seed as seedDatabase } from './demo/seed';
import { buildDriftCallbacks } from './drift/callbacks';
import { runDriftSweep } from './drift/driftEngine';
import { BullmqScheduler } from './drift/scheduler/bullmqScheduler';
import { InMemoryScheduler } from './drift/scheduler/inMemoryScheduler';
import type { Scheduler } from './drift/scheduler/scheduler';
import { createContactVault } from './ingest/contactVaultStore';
import { MemoryDedupeStore, PgDedupeStore } from './ingest/dedupe';
import { SlackNotifier } from './ingest/notifier';
import { buildSlackApp, type MutableRoles } from './ingest/slackApp';
import { NeedService } from './ledger/needService';
import type { EventStore } from './ledger/store/eventStore';
import { InMemoryEventStore } from './ledger/store/memoryStore';
import { PostgresEventStore } from './ledger/store/postgresStore';
import { InMemoryAuditLog, PgAuditLog } from './lib/auditLog';
import { runStartupMigrations } from './lib/bootstrap';
import { logger } from './lib/logger';
import { createLlm, type LlmProvider } from './llm/provider';
import { loadLocalityCoords, loadSeedVolunteers } from './match/seedData';
import { InMemoryVolunteerStore, PgVolunteerStore, type VolunteerStore } from './match/volunteerStore';
import { makeIntakeJobHandler } from './pipeline/intakeJob';
import { BullMQQueue, InlineQueue, type PipelineQueue } from './pipeline/queue';
import { SlackTextFetcher } from './pipeline/textFetcher';

// Live-mode boot (BUILD-DOC §9, §16.2). Thin by design — all logic lives in the
// modules. Substrate is config-driven and degrades gracefully: Postgres + BullMQ
// when DATABASE_URL / REDIS_URL are set, otherwise in-memory + inline (still a real
// Slack surface). For the hermetic, no-Slack storyboard run `npm run demo`.

async function main(): Promise<void> {
  const { botToken, signingSecret, appToken } = config.slack;
  // Socket Mode needs bot + app tokens; HTTP mode needs bot token + signing secret.
  const canRunLive = botToken !== '' && (appToken !== '' || signingSecret !== '');
  if (!canRunLive) {
    logger.warn(
      'relay: live mode needs SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (HTTP). ' +
        'For the no-infra storyboard run `npm run demo`.',
    );
    process.exit(0);
  }

  // Apply pending schema migrations BEFORE building stores or serving (review finding: a fresh
  // ECS task used to boot "healthy" against an empty schema). Idempotent + advisory-locked so
  // concurrent rollouts serialize. A migration failure must NOT serve a schema-less app — log
  // and exit non-zero so the deploy fails loudly and the ALB never routes to a broken task.
  if (config.databaseUrl) {
    try {
      await runStartupMigrations(config.databaseUrl);
    } catch (err) {
      logger.error({ err }, 'relay: startup migrations failed — refusing to serve without a schema');
      process.exit(1);
    }

    // Seed the org roster + gazetteer on boot (idempotent upserts by name / slack_user_id).
    // A fresh Postgres has an empty localities table — but the geocoder stamps needs with a
    // gazetteer id (1-based array index), so without the rows every located need FK-violates,
    // and matching has no volunteers. Seeding the empty table in file order lands ids 1..N that
    // match the geocoder's contract. Best-effort: a seed failure degrades matching but must NOT
    // take down the server (the ledger + healthz still work).
    try {
      const counts = await seedDatabase(config.databaseUrl);
      logger.info(counts, 'relay: startup seed applied (localities + volunteers)');
    } catch (err) {
      logger.error({ err }, 'relay: startup seed failed — matching/geocoding may be degraded until fixed');
    }
  }

  const pool = config.databaseUrl ? new pg.Pool({ connectionString: config.databaseUrl }) : null;

  let store: EventStore;
  if (pool) {
    const pgStore = new PostgresEventStore({ pool });
    await pgStore.init();
    store = pgStore;
  } else {
    store = new InMemoryEventStore();
  }
  const service = new NeedService(store);

  const dedupe = pool ? new PgDedupeStore(pool) : new MemoryDedupeStore();

  // Shared, mutable channel roles — filled by app start(); the notifier reads the
  // dispatch id through the same object so it sees the resolved value.
  const roles: MutableRoles = { intakeChannelId: '', dispatchChannelId: '', hqChannelId: '', judgesChannelId: '' };

  // One bot Web client, shared by the notifier (posts) and the pipeline text fetcher (reads),
  // both independent of Bolt's receiver.
  const botClient = new WebClient(botToken);
  const notifier = new SlackNotifier(botClient, () => roles.dispatchChannelId);

  // P-1 extractor: the real provider when a key is configured, else the deterministic heuristic
  // so intake still classifies (offline). The core pipeline is provider-agnostic. The extractor is
  // now chosen PER JOB inside the intake worker (selectExtractor) from the llm below, so the live
  // "/relay demo degrade llm" toggle can unplug the AI without a restart.
  const hasLlmKey = config.llmProvider === 'anthropic' ? config.anthropicApiKey !== '' : config.openaiApiKey !== '';
  // Encrypted contact vault (Postgres when a pool exists, else in-memory; disabled
  // with a single warning when CONTACT_VAULT_KEY is unset).
  const vault = createContactVault({ keyHex: config.contactVaultKey, pool });

  // Volunteer roster + gazetteer coords for the matcher. Postgres roster in prod
  // (seeded via `npm run seed`); in-memory seeded from seed/volunteers.json for a
  // no-DB dev boot so matching + `/relay volunteers` work offline. The contact-hash
  // key threads through so exact-contact dedupe is stable; empty → the fixed dev salt.
  const volunteerStore: VolunteerStore = pool
    ? new PgVolunteerStore({ pool })
    : new InMemoryVolunteerStore(loadSeedVolunteers());
  const localities = loadLocalityCoords();
  const auditLog = pool ? new PgAuditLog(pool) : new InMemoryAuditLog();
  const rationaleLlm: LlmProvider | undefined = hasLlmKey ? createLlm() : undefined;
  const contactHashKey = config.contactVaultKey || undefined;

  const jobHandler = makeIntakeJobHandler({
    service,
    notifier,
    llm: rationaleLlm,
    vault,
    store,
    contactHashKey,
    isDemo: false,
  });
  // Zero-copy text reconstitution (invariant #5): the durable BullMQ job carries only Slack
  // references, never the message text, so the worker RE-FETCHES the single message from Slack
  // (conversations.history/replies) before extraction. Without this the Redis worker ran the
  // handler with no text → every need stuck NEW/other/low and Confirm hit ILLEGAL_TRANSITION.
  const textFetcher = new SlackTextFetcher(botClient);
  let queue: PipelineQueue;
  if (config.redisUrl) {
    const bull = new BullMQQueue({ redisUrl: config.redisUrl, handler: jobHandler, textFetcher });
    bull.startWorker();
    queue = bull;
  } else {
    queue = new InlineQueue(jobHandler);
  }

  // Drift side effects (SLA nudges + reassignment cards), built once and shared by the
  // Slack drift handlers and the sweep worker so both use one reassignment implementation.
  const resolvePublicId = async (needId: string): Promise<string> => (await store.getPublicId(needId)) ?? needId;
  const { notifyNudge, proposeReassign } = buildDriftCallbacks({
    service,
    notifier,
    volunteerStore,
    localities,
    resolvePublicId,
    llm: rationaleLlm,
  });

  // One drift pass over the real ledger at clock `now` — the SAME closure the scheduler ticks,
  // the in-process wall-clock tick fires (below), and the live hero demo runs on cue. Idempotent
  // through the ledger's deterministic Nudged keys, so overlapping callers never double-notify.
  const driftSweepNow = async (now: number): Promise<void> => {
    await runDriftSweep({ service, listNeeds: (n) => service.listNeeds(n), notifyNudge, proposeReassign, now });
  };

  // The 60s drift worker (§F4): durable BullMQ tick when REDIS_URL is set, else the timer-free
  // in-memory scheduler. In live mode the in-process wall-clock tick below is the PRIMARY drift
  // driver (robust for a single-task Fargate service — no Redis needed); the BullMQ scheduler,
  // when present, is a durable belt that fires the same idempotent sweep.
  const scheduler: Scheduler = config.redisUrl
    ? new BullmqScheduler({ redisUrl: config.redisUrl })
    : new InMemoryScheduler();
  scheduler.start(async (now) => {
    try {
      await driftSweepNow(now);
    } catch (err) {
      logger.error({ err }, 'drift sweep failed');
    }
  });

  // F8 judge experience: the flood scenario the "Run demo" button + `/relay demo start` play, and
  // the reset seam (Postgres purge in prod, an in-memory stand-in offline — a true purge of the
  // in-memory ledger needs Postgres, so offline reset only republishes App Home).
  let demoScenario: Scenario | undefined;
  try {
    demoScenario = parseScenario(readFileSync(new URL('../demo/scenarios/flood-1.yaml', import.meta.url), 'utf8'));
  } catch (err) {
    logger.warn({ err }, 'relay: could not load demo scenario (judge demo disabled)');
  }
  const demoResetStore = pool ? new PgDemoResetStore({ pool }) : new InMemoryDemoResetStore();

  // Deep-health seam for GET /healthz: a dedicated, lazy Redis client whose ONLY job is PING
  // (BullMQ owns its own worker connections). lazyConnect defers the socket until the first
  // probe; a low retry ceiling + the health probe's short timeout make a dead Redis surface as
  // 'fail' fast. An 'error' listener is mandatory — an unhandled ioredis 'error' would crash.
  const healthRedis = config.redisUrl
    ? new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
    : null;
  healthRedis?.on('error', (err) => logger.debug({ err }, 'relay: health redis client error (probe will report fail)'));
  const redisPing: (() => Promise<string>) | undefined = healthRedis ? () => healthRedis.ping() : undefined;

  const { start, refreshHomes } = buildSlackApp({
    botToken,
    signingSecret,
    appToken: appToken || undefined,
    port: config.port,
    service,
    queue,
    dedupe,
    notifier,
    roles,
    channelConfig: {
      intakeChannelId: process.env.RELAY_INTAKE_CHANNEL,
      dispatchChannelId: process.env.RELAY_DISPATCH_CHANNEL,
      hqChannelId: process.env.RELAY_HQ_CHANNEL,
      judgesChannelId: process.env.RELAY_JUDGES_CHANNEL,
    },
    volunteerStore,
    localities,
    store,
    vault,
    auditLog,
    llm: rationaleLlm,
    isDemo: false,
    slaMultiplier: config.slaMultiplier,
    proposeReassign,
    driftSweep: driftSweepNow,
    demoScenario,
    demoResetStore,
    slackUserToken: config.slack.userToken || undefined,
    // Short per-probe timeout keeps /healthz snappy for UptimeRobot's 5-min poll (§13.2).
    health: { pool, redisPing, timeoutMs: 800 },
  });

  logger.info(
    {
      store: pool ? 'postgres' : 'memory',
      queue: config.redisUrl ? 'bullmq' : 'inline',
      drift: config.redisUrl ? 'bullmq' : 'inmemory',
      extractor: rationaleLlm ? `llm:${rationaleLlm.name}` : 'heuristic',
      vault: vault ? 'on' : 'off',
    },
    'relay: booting live mode',
  );
  await start();

  // Live wall-clock drift tick (§F4). We are past the `canRunLive` guard, so this ONLY runs in a
  // real deployment (never in hermetic tests or `npm run demo`, which use the virtual-clock
  // scheduler + injected sleeps). A single in-process interval is the robust choice for a
  // single-task Fargate service: it needs no Redis, so autonomous SLA drift + App Home refresh
  // fire even in the memory/inline substrate. Every tick runs the idempotent sweep, then
  // re-publishes each open App Home so drifting obligations surface without a manual refresh.
  const DRIFT_TICK_MS = 30_000;
  const driftTick = setInterval(() => {
    void (async () => {
      try {
        await driftSweepNow(Date.now());
        await refreshHomes();
      } catch (err) {
        logger.error({ err }, 'relay: drift tick failed');
      }
    })();
  }, DRIFT_TICK_MS);
  // Don't let the interval by itself hold the process open (Bolt's server already does).
  driftTick.unref?.();
  logger.info({ everyMs: DRIFT_TICK_MS }, 'relay: wall-clock drift tick started');

  // Graceful shutdown (Fargate sends SIGTERM): stop the tick + release scheduler connections.
  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'relay: shutting down');
    clearInterval(driftTick);
    void scheduler.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// A long-running server must not die from a single stray background rejection.
// Slack side-effects (a startup post, a drift nudge, an App Home refresh) can be
// fire-and-forget; if one rejects while a machine is briefly mis-tokened or a
// channel is unresolved, Node's default is to terminate the process — which would
// take /healthz down and crash-loop the deploy. Log and keep serving instead. A
// genuinely fatal boot error still exits via main().catch below.
process.on('unhandledRejection', (reason) => {
  logger.error(
    { err: reason instanceof Error ? reason.message : String(reason) },
    'relay: unhandled rejection (kept alive)',
  );
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message }, 'relay: uncaught exception (kept alive)');
});

main().catch((err) => {
  logger.error({ err }, 'relay: failed to start');
  process.exit(1);
});

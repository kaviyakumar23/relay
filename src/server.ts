import { readFileSync } from 'node:fs';
import { WebClient } from '@slack/web-api';
import Redis from 'ioredis';
import pg from 'pg';
import { parseScenario, type Scenario } from '../demo/scenarios/schema';
import { config } from './config';
import { InMemoryDemoResetStore, PgDemoResetStore } from './demo/reset';
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
import { type Extractor, HeuristicExtractor, LlmExtractor } from './pipeline/extract';
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

  // P-1 extractor: the real provider when a key is configured, else the deterministic
  // heuristic so intake still classifies (offline). The core pipeline is provider-agnostic.
  const hasLlmKey = config.llmProvider === 'anthropic' ? config.anthropicApiKey !== '' : config.openaiApiKey !== '';
  const extractor: Extractor = hasLlmKey ? new LlmExtractor(createLlm()) : new HeuristicExtractor();
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
    extractor,
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

  // The 60s drift worker (§F4): durable BullMQ tick when REDIS_URL is set, else the timer-free
  // in-memory scheduler (which only fires when a caller advances its virtual clock — the demo
  // runner does; live-without-Redis therefore has no autonomous drift, by design).
  const scheduler: Scheduler = config.redisUrl
    ? new BullmqScheduler({ redisUrl: config.redisUrl })
    : new InMemoryScheduler();
  scheduler.start(async (now) => {
    try {
      await runDriftSweep({ service, listNeeds: (n) => service.listNeeds(n), notifyNudge, proposeReassign, now });
    } catch (err) {
      logger.error({ err }, 'drift sweep failed');
    }
  });
  if (!config.redisUrl) {
    logger.warn('relay: no REDIS_URL — drift worker will not tick autonomously (set REDIS_URL for live SLA drift)');
  }

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

  const { start } = buildSlackApp({
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
      extractor: extractor.name,
      vault: vault ? 'on' : 'off',
    },
    'relay: booting live mode',
  );
  await start();
}

main().catch((err) => {
  logger.error({ err }, 'relay: failed to start');
  process.exit(1);
});

import { WebClient } from '@slack/web-api';
import pg from 'pg';
import { config } from './config';
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
import { logger } from './lib/logger';
import { createLlm, type LlmProvider } from './llm/provider';
import { loadLocalityCoords, loadSeedVolunteers } from './match/seedData';
import { InMemoryVolunteerStore, PgVolunteerStore, type VolunteerStore } from './match/volunteerStore';
import { type Extractor, HeuristicExtractor, LlmExtractor } from './pipeline/extract';
import { makeIntakeJobHandler } from './pipeline/intakeJob';
import { BullMQQueue, InlineQueue, type PipelineQueue } from './pipeline/queue';

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
  const roles: MutableRoles = { intakeChannelId: '', dispatchChannelId: '' };

  // The notifier posts via its own Web client (independent of Bolt's receiver).
  const notifier = new SlackNotifier(new WebClient(botToken), () => roles.dispatchChannelId);

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
  let queue: PipelineQueue;
  if (config.redisUrl) {
    const bull = new BullMQQueue({ redisUrl: config.redisUrl, handler: jobHandler });
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

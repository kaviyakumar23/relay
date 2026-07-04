import { WebClient } from '@slack/web-api';
import pg from 'pg';
import { config } from './config';
import { MemoryDedupeStore, PgDedupeStore } from './ingest/dedupe';
import { SlackNotifier } from './ingest/notifier';
import { buildSlackApp, type MutableRoles } from './ingest/slackApp';
import { NeedService } from './ledger/needService';
import type { EventStore } from './ledger/store/eventStore';
import { InMemoryEventStore } from './ledger/store/memoryStore';
import { PostgresEventStore } from './ledger/store/postgresStore';
import { logger } from './lib/logger';
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

  const jobHandler = makeIntakeJobHandler({ service, notifier, isDemo: false });
  let queue: PipelineQueue;
  if (config.redisUrl) {
    const bull = new BullMQQueue({ redisUrl: config.redisUrl, handler: jobHandler });
    bull.startWorker();
    queue = bull;
  } else {
    queue = new InlineQueue(jobHandler);
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
  });

  logger.info(
    { store: pool ? 'postgres' : 'memory', queue: config.redisUrl ? 'bullmq' : 'inline' },
    'relay: booting live mode',
  );
  await start();
}

main().catch((err) => {
  logger.error({ err }, 'relay: failed to start');
  process.exit(1);
});

import 'dotenv/config';

// Frozen, allowlisted config — the only place process.env is read (impactlens pattern).
// Offline-first: everything defaults so hermetic tests and `npm run demo` need no env.
const env = process.env;

export const config = Object.freeze({
  slack: Object.freeze({
    botToken: env.SLACK_BOT_TOKEN ?? '',
    signingSecret: env.SLACK_SIGNING_SECRET ?? '',
    // Presence of an app-level token switches Bolt to Socket Mode (local dev).
    appToken: env.SLACK_APP_TOKEN ?? '',
  }),
  // LLM provider is swappable — the core pipeline needs an LLM, not a specific
  // vendor. Default 'openai'; set LLM_PROVIDER=anthropic to switch. Both key
  // slots exist so either works and dedupe embeddings (OpenAI) can coexist.
  llmProvider: (env.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai') as 'openai' | 'anthropic',
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  openaiApiKey: env.OPENAI_API_KEY ?? '',
  databaseUrl: env.DATABASE_URL ?? '',
  redisUrl: env.REDIS_URL ?? '',
  port: Number(env.PORT ?? 3000),
  logLevel: env.LOG_LEVEL ?? 'info',
  contactVaultKey: env.CONTACT_VAULT_KEY ?? '',
  // Demo SLA compression (§12.3): 0.02 turns a 45-min SLA into ~54s. Labeled for judges.
  slaMultiplier: Number(env.SLA_MULTIPLIER ?? 1),
});

export type Config = typeof config;

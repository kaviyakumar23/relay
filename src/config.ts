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
    // User token (xoxp-) for the Real-Time Search API (search:read.* are user-token
    // scopes; a user token needs no action_token). Empty ⇒ RTS falls back to the mock
    // and the integrator removes the RTS row from the qualifying-tech table (CLAUDE.md
    // §9 honesty rule). See src/assistant/rts.ts.
    userToken: env.SLACK_USER_TOKEN ?? '',
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
  // The MCP server is READ-ONLY by default. The single WRITE tool (pledge_support, Moonshot #2 —
  // an external agent pledging to fulfil a need) is OPT-IN: it only accepts input when this flag
  // is truthy. Default false, so the hosted server and every hermetic test expose no write surface
  // unless an operator explicitly enables it. Even when enabled, a pledge is only a PROPOSAL — a
  // human coordinator must confirm it (the existing Assign human gate); the flag never bypasses that.
  mcpWritesEnabled: env.RELAY_MCP_WRITES_ENABLED === '1' || env.RELAY_MCP_WRITES_ENABLED?.toLowerCase() === 'true',
});

export type Config = typeof config;

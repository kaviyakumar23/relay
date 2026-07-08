# Relay — Setup Checklist

Click-by-click steps to get Relay running locally against a real Slack workspace.
None of this is needed for `npm test` / `npm run demo` (both run with zero config).

## 1. Prerequisites (already installed on the build machine)

- Node ≥ 22, npm, Docker Desktop (running), git.
- `npm install` at the repo root.

## 2. Local data substrate

```bash
docker compose up -d          # Postgres 16 (pgvector) on :5433, Redis 7 on :6379
```

Postgres is published on host port **5433** (not 5432) so it never collides with a
host Postgres. If `docker compose ps` doesn't show both `healthy`, wait a few seconds.

## 3. LLM key (OpenAI by default)

Relay's LLM layer is provider-agnostic; the default is OpenAI.

1. Get a key at <https://platform.openai.com/api-keys> (starts `sk-...`).
2. It will go in `.env` as `OPENAI_API_KEY` (step 5). Dedupe embeddings reuse the
   same key (`text-embedding-3-small`); without it, dedupe falls back to `pg_trgm`.

To use Claude instead: set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=sk-ant-...`.
Nothing else changes — the seam handles it.

## 4. Slack dev app (Socket Mode — no public URL needed)

1. Join the **Slack Developer Program** (<https://api.slack.com/developer-program>)
   and provision a sandbox workspace (free, instant).
2. Go to <https://api.slack.com/apps> → **Create New App** → **From an app manifest**
   → pick the sandbox workspace → paste the contents of **`manifest.dev.yaml`** → Create.
3. **Install to Workspace** (Settings → Install App). Copy the **Bot User OAuth Token**
   (`xoxb-...`) → this is `SLACK_BOT_TOKEN`.
4. **Basic Information → App-Level Tokens → Generate Token and Scopes**: name it
   `socket`, add scope **`connections:write`**, generate. Copy (`xapp-...`) → this is
   `SLACK_APP_TOKEN`.
5. **Basic Information → App Credentials**: copy the **Signing Secret** →
   `SLACK_SIGNING_SECRET`.
6. In the sandbox workspace, create these five channels and **invite the bot to each**
   (`/invite @relay`) — message events only fire in channels the bot is a member of:
   `#relay-intake` `#relay-dispatch` `#relay-volunteers` `#relay-hq` `#judges-start-here`
7. (Optional) Override channel resolution by ID in `.env`:
   `RELAY_INTAKE_CHANNEL` and `RELAY_DISPATCH_CHANNEL`.

## 5. Fill `.env`

```bash
cp .env.example .env
```

Set: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`, `OPENAI_API_KEY`,
`DATABASE_URL=postgres://relay:relay@localhost:5433/relay`, `REDIS_URL=redis://localhost:6379`,
and `CONTACT_VAULT_KEY=$(openssl rand -hex 32)`.

## 6. Migrate, seed, run

```bash
npm run db:migrate            # applies db/migrations/*.sql (pgvector + append-only triggers)
npm run seed                  # 40 localities + 12 volunteers (is_demo)
npm run dev                   # Socket Mode — connects to your sandbox
```

Post a message in `#relay-intake` → a dispatch card appears in `#relay-dispatch`.

## 7. Verify without Slack anytime

```bash
npm test                 # 61 hermetic unit tests, zero config
npm run demo             # in-memory flood-1 storyboard (14 needs)
npm run eval             # extraction eval harness (needs the LLM key once P-1 lands)
npm run scenario:lint    # validate scenario + eval set schemas
```

## 8. Production (Fly.io) — later

The live host is **Fly.io** (AWS is account-restricted for this project). Full
runbook: **`docs/DEPLOY.md`**. In short, from the repo root:

```bash
fly auth login
fly apps create relay-crisis
fly postgres create --name relay-db --region sin && fly postgres attach relay-db --app relay-crisis
fly redis create --name relay-redis --region sin   # → set REDIS_URL secret
fly secrets set --app relay-crisis SLACK_BOT_TOKEN=… SLACK_SIGNING_SECRET=… OPENAI_API_KEY=… CONTACT_VAULT_KEY="$(openssl rand -hex 32)"
fly deploy --remote-only                            # migrations run on boot
```

`manifest.prod.yaml` already points at `https://relay-crisis.fly.dev/slack/events`;
update the prod Slack app from the manifest and switch to the HTTP-mode app. The
AWS CDK in `infra/` is retained only as a portable alternative (~$55/mo vs Fly's
~$10–13/mo).

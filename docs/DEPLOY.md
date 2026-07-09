# Relay — Fly.io deploy runbook

The live, always-on target for the judging window (Jul 14 – Aug 6) is **Fly.io**.
We moved off AWS because the AWS account is under an account-level restriction.

Fly builds our repo-root `Dockerfile` and gives us an HTTPS `*.fly.dev` URL out of
the box — so the old CloudFront layer (which existed only to hand Slack a TLS
request URL) is dropped. Config lives in `fly.toml`. The archived AWS CDK stack is
retained as a portable alternative under `infra/` (see `infra/README.md`).

> None of this is needed for `npm test` / `npm run demo` — both run fully
> hermetically with zero infra. This runbook is only for the hosted HTTP-mode app.

## What runs where

```
Slack  ──https──▶  relay-crisis.fly.dev  (Fly machine, always-on, /healthz gated)
                          ├─▶  Fly Postgres  (self-hosted, pgvector optional)
                          └─▶  Upstash Redis (Fly extension, BullMQ)
```

- Auto-HTTPS on `*.fly.dev` — no CloudFront/ALB/cert to manage.
- One machine pinned up (`min_machines_running = 1`, `auto_stop_machines = false`)
  so the drift tick + BullMQ scheduler never sleep and the demo never cold-starts.
- Schema migrations run on boot (`runStartupMigrations`, advisory-locked +
  idempotent) before the app serves; a migration failure exits non-zero so a
  schema-less machine never takes traffic.

## Prerequisites

```bash
brew install flyctl        # or: curl -L https://fly.io/install.sh | sh
fly auth login             # one browser round-trip; all resources on one account
```

## 1. Create the app

```bash
# From the repo root (fly.toml already declares app = 'relay-crisis'):
fly apps create relay-crisis
# — or, to let Fly reconcile the existing config without deploying yet:
# fly launch --no-deploy --copy-config
```

## 2. Provision self-hosted Postgres

Plain Fly Postgres is enough — Relay runs on it and dedupes via `pg_trgm`. The
pgvector embedding path is **optional**: it activates only when `OPENAI_API_KEY`
is set *and* the Postgres has the `vector` extension. Without either, dedupe falls
back to `pg_trgm` and the app is fully functional.

```bash
fly postgres create --name relay-db --region sin --vm-size shared-cpu-1x --volume-size 10
fly postgres attach relay-db --app relay-crisis
# `attach` creates a DB user + sets the DATABASE_URL secret on relay-crisis.
```

To enable the embedding dedupe path later, exec into the pg instance and
`CREATE EXTENSION vector;` (the boot migration also attempts it and degrades
gracefully if the extension is unavailable).

## 3. Provision Redis (Upstash — Fly extension)

```bash
fly redis create --name relay-redis --region sin
# — or the extension form:
# fly ext upstash-redis create --name relay-redis
fly redis status relay-redis        # copy the redis:// URL
fly secrets set REDIS_URL='redis://…' --app relay-crisis
```

The Upstash free tier is sufficient for demo/judging traffic.

## 4. Set app secrets

```bash
fly secrets set --app relay-crisis \
  SLACK_BOT_TOKEN='xoxb-…' \
  SLACK_SIGNING_SECRET='…' \
  OPENAI_API_KEY='sk-…' \
  CONTACT_VAULT_KEY="$(openssl rand -hex 32)"
```

`DATABASE_URL` (step 2) and `REDIS_URL` (step 3) are already set. To use Claude
instead of OpenAI, set `LLM_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=sk-ant-…`
(the seam handles it — see `src/llm/`). Setting secrets triggers a rolling
restart, which is harmless before the first deploy.

### Optional: enable the MCP write tool (`pledge_support`, Moonshot #2)

Relay's MCP server is read-only by default. The single write tool — `pledge_support`,
which lets an external agent pledge to fulfil a need — is **opt-in**. It only accepts
input when `RELAY_MCP_WRITES_ENABLED` is truthy:

```bash
fly secrets set --app relay-crisis RELAY_MCP_WRITES_ENABLED=1
```

Leaving it unset (the default) keeps the server read-only: `pledge_support` is still
listed, but returns a clear *"writes disabled"* result and never touches the ledger.
Even when enabled, a pledge is only a **proposal** — a human coordinator must confirm
it through the existing Assign human gate before it becomes a tracked commitment, so
this flag never weakens the "a human confirms every consequential transition" invariant.
The `is_agent` volunteers column ships in migration `db/migrations/004_agent_volunteers.sql`,
which runs automatically on boot with the others.

## 5. Deploy

```bash
fly deploy --remote-only        # builds the repo Dockerfile on Fly's builders
```

Migrations run automatically on boot — no separate migrate step. Watch the boot
log to confirm `runStartupMigrations` completed and `/healthz` went green:

```bash
fly logs --app relay-crisis
fly status --app relay-crisis
```

## 6. Point Slack at the Fly URL

The app is served at **https://relay-crisis.fly.dev**. `manifest.prod.yaml`
already targets that host (request URL `https://relay-crisis.fly.dev/slack/events`).
Update the prod Slack app from the manifest (App config → App Manifest → paste),
verify the Request URL, and reinstall if scopes changed.

Health check:

```bash
curl -i https://relay-crisis.fly.dev/healthz     # 200 when pg + redis are reachable
```

## CI deploys

`.github/workflows/deploy.yml` deploys on push to `main` touching `fly.toml`,
`src/**`, or `Dockerfile` (and on manual `workflow_dispatch`). Set the deploy
token once:

```bash
fly tokens create deploy -x 999999h        # or: fly auth token
# → GitHub → repo Settings → Secrets and variables → Actions → new secret
#   FLY_API_TOKEN = <the token>
```

The deploy step is guarded on `FLY_API_TOKEN` being present, so the workflow is a
no-op on forks / until the secret is configured.

## Cost estimate (~monthly)

| Resource | Spec | Est. USD/mo |
|---|---|---|
| App machine | shared-cpu-1x / 1 GB, always-on | ~$5–6 |
| Fly Postgres | shared-cpu-1x, 10 GB volume | ~$3–5 |
| Upstash Redis | free tier | $0 |
| **Total** | | **~$10–13/mo** |

Roughly 5× cheaper than the old AWS stack (~$55/mo), and no NAT/ALB/CloudFront to
reason about.

## Teardown

```bash
fly apps destroy relay-crisis
fly postgres detach relay-db --app relay-crisis   # if the app still exists
fly apps destroy relay-db
fly redis destroy relay-redis
```

Clean and complete — appropriate for a hackathon, not for production data.

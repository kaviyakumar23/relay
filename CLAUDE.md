# Relay — CLAUDE.md

## What Relay is

Relay is a Slack-native agent for volunteer crisis response: **Intake → Triage → Match → Commit → Verify → Report**. Needs and volunteer commitments live in an append-only, event-sourced ledger; deliveries close only on evidence; donor reports carry only verified, source-linked numbers. **Relay never treats a single message as truth.** The LLM interprets language; deterministic code controls state; humans confirm every consequential transition. Full spec: `docs/BUILD-DOC.md`.

## Hard deadlines (2026)

- **Jul 10, 9 PM IST — feature freeze.** After freeze, any commit touching the demo path needs two human approvals.
- **Jul 12, 9 PM IST — Devpost submission.** Jul 13 is buffer; never touch it.
- **Jul 14 – Aug 6 — judging.** The hosted app and sandbox must stay alive and demo-ready the whole window. No risky deploys.
- The demo path is sacred: injector → triage → assign → drift → reassign → evidence close → sitrep. If a change might break it, run `demo-qa` first.

## Non-negotiable invariants

1. `need_events` is **append-only** (DB trigger enforces it). State changes happen only by appending typed events; `needs.status` is a projection that only `src/ledger/` code may write, always derived from events. Never `UPDATE needs SET status` anywhere else.
2. **Consequential transitions require a human actor event** (`actor_type: 'human'`): confirm-triage (low confidence or critical), assign, merge, verify-close, cancel. Agent/system events handle the rest. The engine rejects, it doesn't trust callers.
3. Every LLM output is **Zod-validated at the boundary**; on failure: one repair pass, then `NEEDS_REVIEW` + human card. Never guess, never free-parse.
4. **Severity floors only raise.** Keyword floors (trapped/drowning/dialysis/child…) are deterministic and can never be lowered by a model. The single source of truth for the floor keyword list lives in `src/pipeline/severityFloor.ts` (runtime code must not import from `eval/`, which Docker excludes); `eval/score.ts` re-exports it so the gold set and the runtime extractor stay byte-identical.
5. **Beneficiary PII lives only in `contact_vault`** (AES-256-GCM). Cards show a reveal button that writes an `audit_log` row. Redaction runs **before** any LLM call. No names/phones/addresses in logs — use safeLog-style derived fields only.
6. **Ack < 3s, work async.** Slack handlers ack immediately and enqueue; placeholders update via `chat.update`.
7. **Idempotency at two layers:** `slack_events` transport dedupe + deterministic business keys (`src/ledger/idempotency.ts`) against `need_events.idempotency_key UNIQUE`.
8. Per-channel ~1 msg/s send budget — injector and drift engine share the token bucket.
9. **RTS results are never persisted** (API ToS) — query-time only, cite permalinks.
10. All demo data is flagged `is_demo` and posted by the labeled "Relay Simulator 🧪" identity. Judges must never wonder whether the flood is real.

## Commands

- `docker compose up -d` — local Postgres (pgvector) + Redis
- `npm run dev` (Socket Mode) · `npm start` (HTTP) · `npm run db:migrate` · `npm run seed`
- `npm test` (hermetic — must pass with zero env) · `npm run test:integration` (needs compose)
- `npm run typecheck` · `npm run lint` · `npm run eval` · `npm run demo` · `npm run scenario:lint`

## Repo map

- `src/ledger/` — event store, taxonomy, state machine, projection, decide/service (the core; port of kept's engine)
- `src/ingest/` — Bolt app wiring, event handlers, transport dedupe
- `src/pipeline/` — extraction → validation → dedupe → geocode workers (BullMQ)
- `src/match/` — deterministic scorer + LLM rationale
- `src/drift/` — SLA timers, nudges, reassignment (delayed jobs + 60s repeatable sweep)
- `src/narrate/` — sitrep/report generators, `{{stat:*}}` token validator, PII redaction
- `src/surfaces/` — Block Kit builders, App Home, modals, Canvas
- `src/assistant/` — Assistant class wiring, RTS client (throttled)
- `src/mcp-server/` — read-only MCP endpoint (P1)
- `src/demo/` — injector, reset, seed, storyboard driver
- `src/llm/` — provider seam (structured outputs), per-task model config, prompts P-1..P-7 in `src/llm/prompts/`
- `src/lib/` — logger, migrate, ids, safeLog, vault crypto
- `eval/` — labeled intake set + gates; `demo/scenarios/` — injector scripts; `seed/` — gazetteer + roster; `fly.toml` + `docs/DEPLOY.md` — Fly.io deploy (live host); `infra/` — archived AWS CDK (reference alt; AWS is account-restricted)

## Reuse provenance — port, don't import

Patterns come from sibling repos (read them before reinventing): `../kept` (event store, projection, state machine, scheduler, LLM seam, Bolt skeleton), `../inview` (RTS client `slack-data/rts.js`, assistant manifest bits, verified platform facts in `docs/DECISIONS.md`), `../impactlens` (PII detectors, number-integrity gates, safeLog). Those repos are JS or differently-typed — **port code into Relay's TS-strict style; never import across repos.** Known donor gaps we fixed here: LLM repair pass, RTS throttle/retry, transport event dedupe, Indian mobile detection.

## Conventions

- TypeScript strict, pure ESM, extensionless imports, tsx runtime (no build), Node ≥22.
- Zod at every boundary (Slack payloads, LLM output, scenario/eval files, env-derived config).
- Block Kit action IDs encode the target: `action:entityId` via `actionId()/parseActionId()` (`src/surfaces/`).
- Tests are hermetic-first (memory store, inline queue, RecordingNotifier); real-infra tests live in `tests/integration/` and `describe.skipIf` without env.
- Biome for lint/format (single quotes, 2-space, width 120). `console` is banned outside `console.error` in CLI entrypoints — use `logger`.
- **LLM is provider-agnostic** (`src/llm/`): `createLlm()` picks OpenAI or Anthropic from `LLM_PROVIDER` (default openai). Both use forced tool use + `z.toJSONSchema` + Zod validation at the boundary, with a one-pass repair → `LlmParseError` (caller maps to `NEEDS_REVIEW`). Never call a vendor SDK directly outside `src/llm/`; go through the `LlmProvider` seam so the swap stays one env var. Tests use `MockLlm` through the same boundary.
- Prompts are named files in `src/llm/prompts/` (P-1 intake-extraction … P-7 ask-relay). Per-task model tiers live in `src/llm/models.ts` (`TASK_TIER`): quality tier for P-1/P-5/P-6/P-7, cheap tier for P-2/P-3/P-4; each provider resolves the tier to a concrete model.

## Cut lines (pre-agreed — slips trigger cuts, not debates)

Cut in order: language-matched replies → Canvas updates (keep message sitreps) → RTS grounding (keep ledger-only answers **and remove the RTS row from the submission's tech table — honesty rule**) → MCP server → merge-suggestion UI (keep exact-contact auto-link). **Never cut:** the ledger, verification/evidence gating, the drift-reassign hero moment, App Home, the judge demo runner.

## Eval honesty

Publish only numbers `npm run eval` actually produced. If a metric is bad, fix it or publish it with the mitigation. Never claim a qualifying technology the shipped code doesn't use. No invented impact statistics — that violates both the rules and the product's own ethos.

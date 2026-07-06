# Relay — Crisis Coordination inside Slack

> In a disaster, the deadliest thing is a lost message. Relay turns the chaos of volunteer Slack channels into a verified, accountable relief operation: every need captured, every "I'll take it" tracked as a promise, every delivery proven, every donor report backed by evidence.

Built for the **Slack Agent Builder Challenge 2026 — Agent for Good track**. Uses all three qualifying technologies: **Slack AI capabilities** (assistant threads), the **Real-Time Search API**, and **MCP** (Relay exposes a read-only MCP server).

**The loop:** Intake → Triage → Match → Commit → Verify → Report — on an append-only, event-sourced ledger. The LLM interprets language; deterministic code controls state. Humans confirm every consequential transition.

## 60-second local setup

```bash
npm install
docker compose up -d          # Postgres 16 (pgvector) + Redis 7
cp .env.example .env          # fill in Slack + Anthropic keys (see below)
npm run db:migrate
npm run seed                  # demo gazetteer + volunteer roster
npm run dev                   # Socket Mode against your dev Slack app
```

No keys yet? `npm test` (hermetic, zero infra) and `npm run demo` (in-memory end-to-end storyboard) work with nothing configured.

### Slack dev app

1. Join the [Slack Developer Program](https://api.slack.com/developer-program) and provision a sandbox workspace.
2. Create an app **from manifest** using `manifest.dev.yaml` (Socket Mode — no public URL needed).
3. Create the channels `#relay-intake` `#relay-dispatch` `#relay-volunteers` `#relay-hq` `#judges-start-here` and **`/invite @relay` into each** (message events only fire for channels the bot is in).
4. Put `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and an app-level `SLACK_APP_TOKEN` (connections:write) in `.env`.

Production runs the `manifest.prod.yaml` app in HTTP mode on AWS (see `infra/`).

## Commands

| Command | What |
|---|---|
| `npm run dev` / `start` | Socket-Mode dev / HTTP prod server |
| `npm test` / `test:integration` | Hermetic unit tests / real pg+redis tests |
| `npm run typecheck` / `lint` | `tsc --noEmit` / Biome |
| `npm run eval` | Extraction-accuracy eval on `eval/intake_set.jsonl` — these numbers go in the submission verbatim |
| `npm run demo` | In-memory storyboard run (no Slack, no infra) |
| `npm run mcp` | Read-only MCP server over stdio (for Claude Desktop — see below) |
| `npm run db:migrate` / `seed` | Apply `db/migrations/*.sql` / load demo seed data |
| `npm run scenario:lint` | Validate demo scenario + eval set against their schemas |

## Qualifying technologies

Relay uses all three, each with a real job:

- **Slack AI capabilities** — the **Assistant pane**. Opening a thread sets suggested prompts; a question calls **Ask-Relay** (`src/assistant/askRelay.ts`), which answers grounded in the PII-free ledger, cites permalinks, and refuses out-of-relief-scope questions. No LLM key required — it falls back to a deterministic, ledger-grounded template.
- **Real-Time Search (RTS) API** — Ask-Relay's field-context grounding via a hardened `assistant.search.context` client (`src/assistant/rts.ts`, throttled + retrying). It **lights up when `SLACK_USER_TOKEN` (xoxp-) is set** (the `search:read.*` scopes are user-token scopes); without one it degrades to a deterministic mock and answers ledger-only. RTS results are cited, never persisted (API ToS).
- **MCP** — Relay **exposes a read-only MCP server** (`src/mcp-server/`): `search_needs`, `get_need`, `get_sitrep`, over the same PII-free projections the app uses (never the contact vault).

### MCP server for Claude Desktop

`npm run mcp` serves the read-only tools over stdio. Add Relay to Claude Desktop's `claude_desktop_config.json` (stdout is pure JSON-RPC; logs go to stderr):

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server/stdio.ts"],
      "cwd": "/absolute/path/to/relay"
    }
  }
}
```

With no `DATABASE_URL` the server seeds an in-memory demo flood so the tools return live data with zero setup; set `DATABASE_URL` in the entry's `env` to query the real hosted ledger. Then ask Claude Desktop e.g. *"Use Relay to list open critical needs"* — the numbers match `/relay sitrep` and App Home.

## Docs

- `docs/BUILD-DOC.md` — full build document (product spec, state machine, compliance rules)
- `CLAUDE.md` — engineering invariants (append-only ledger, human gates, PII rules)
- Architecture diagram: `docs/architecture.png` *(added before submission)*

All demo data is fictional. Relay assists volunteer coordinators; it is not an emergency service.

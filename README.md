# Relay — Crisis Coordination inside Slack

> In a disaster, the deadliest thing is a lost message. Relay turns the chaos of volunteer Slack channels into a verified, accountable relief operation: every need captured, every "I'll take it" tracked as a promise, every delivery proven, every donor report backed by evidence.

Built for the **Slack Agent Builder Challenge 2026 — Agent for Good track**. Uses all three qualifying technologies: **Slack AI capabilities** (assistant threads), the **Real-Time Search API**, and **MCP** (Relay exposes a read-only MCP server).

**The loop:** Intake → Triage → Match → Commit → Verify → Report — on an append-only, event-sourced ledger. The LLM interprets language; deterministic code controls state. Humans confirm every consequential transition.

## What exists today (and why Relay is different)

Crisis coordination tools exist, but none close the loop *inside the conversation, with proof*. **Ushahidi / Sahana** are web crisis-mapping platforms that live outside the tools volunteers chat in and don't track who committed to what. **WhatsApp groups** are where coordination actually happens — with zero structure or accountability. **Slack incident tools** (incident.io and similar) target internal IT incidents and close on status flags, not verified fulfillment. Relay's wedge: coordination inside Slack, promises tracked as obligations **with proof of delivery**, and donor-grade accountability.

## Measured extraction quality

On a 40-message labelled set (`npm run eval`, reproducible with no API key via the deterministic baseline): **86.1% field-level accuracy · 100% critical-severity recall · 100% contact/locality accuracy.** These are the only extraction-quality numbers we publish — the product's ethos forbids invented impact statistics.

**Measured intake throughput (local/hermetic).** `npm run load` replays the frozen flood's 14 intake messages through the in-memory pipeline (heuristic extraction, no Slack/DB/Redis), 25×. On this machine: **intake p95 ≈ 0.1–0.2 ms, several thousand msg/s** — a *local, in-memory engine* measurement (reproduce with `npm run load`; exact figures vary run-to-run and are machine-dependent), never a production or Slack-round-trip SLA.

## 60-second local setup

```bash
npm install
docker compose up -d          # Postgres 16 (pgvector) + Redis 7
cp .env.example .env          # fill in Slack + an LLM key (OpenAI or Anthropic; see below)
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

Production runs the `manifest.prod.yaml` app in HTTP mode on **Fly.io** — a Docker
machine (always-on) with self-hosted Fly Postgres + Upstash Redis and auto-HTTPS on
`*.fly.dev` (see `docs/DEPLOY.md`).

## Commands

| Command | What |
|---|---|
| `npm run dev` / `start` | Socket-Mode dev / HTTP prod server |
| `npm test` / `test:integration` | Hermetic unit tests / real pg+redis tests |
| `npm run typecheck` / `lint` | `tsc --noEmit` / Biome |
| `npm run eval` | Extraction-accuracy eval on `eval/intake_set.jsonl` — these numbers go in the submission verbatim |
| `npm run demo` | In-memory storyboard run (no Slack, no infra) |
| `npm run counterfactual` | Measured, clearly-**SIMULATED** delta vs a naive group-chat baseline (Moonshot #3; rules in `docs/BASELINE-RULES.md`) |
| `npm run load` | **MEASURED** intake-throughput replay (**local/hermetic**) — p50/p95/p99 latency + throughput of the in-memory pipeline |
| `npm run mcp` | MCP server over stdio (3 read-only tools + the opt-in `pledge_support` write tool — for Claude Desktop, see below) |
| `npm run db:migrate` / `seed` | Apply `db/migrations/*.sql` / load demo seed data |
| `npm run scenario:lint` | Validate demo scenario + eval set against their schemas |

## Qualifying technologies

Relay uses all three, each with a real job:

- **Slack AI capabilities** — the **Assistant pane**. Opening a thread sets suggested prompts; a question calls **Ask-Relay** (`src/assistant/askRelay.ts`), which answers grounded in the PII-free ledger, cites permalinks, and refuses out-of-relief-scope questions. No LLM key required — it falls back to a deterministic, ledger-grounded template.
- **Real-Time Search (RTS) API** — Ask-Relay's field-context grounding via a hardened `assistant.search.context` client (`src/assistant/rts.ts`, throttled + retrying). It **lights up when `SLACK_USER_TOKEN` (xoxp-) is set** (the `search:read.*` scopes are user-token scopes); without one it degrades to a deterministic mock and answers ledger-only. RTS results are cited, never persisted (API ToS).
- **MCP** — Relay **exposes an MCP server** (`src/mcp-server/`): three read-only tools — `search_needs`, `get_need`, `get_sitrep` — over the same PII-free projections the app uses (never the contact vault), plus one **opt-in write tool**, `pledge_support` (see below).

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

#### `pledge_support` — an agent makes a promise (Moonshot #2: *Relay holds AI agents accountable too*)

The MCP server also carries **one write tool**, `pledge_support`, so an external agent — *"a food bank's agent"* in the story — can pledge to fulfil an open need. It is **opt-in and disabled by default**: it only accepts input when `RELAY_MCP_WRITES_ENABLED=1` (or `=true`) is set in the server's `env`; otherwise it returns a clear *"writes disabled"* message and changes nothing.

Crucially, an agent's pledge is a **proposal, never an auto-commit**. `pledge_support` records the pledge as an **agent-actor `PledgeProposed` event** (registering an `is_agent` volunteer for the pledging org) and moves the need to `MATCH_SUGGESTED` — **it does not assign anyone**. The dispatch card then flags the pending pledge with a **✅ Confirm pledge** button: *"🤖 Pledged via MCP by &lt;agent&gt; — confirm to track it."* That button routes through the **exact same human-gated Assign flow** (`need_assign_pick` → `Assigned` → `CLAIMED`) as any human volunteer, committing the obligation to the agent volunteer named in the pledge; the engine's human gate makes it impossible for the agent to skip that step (an agent-actor `Assigned` is rejected with `HUMAN_GATE`). Once confirmed, the obligation is tracked with the **same SLA, drift detection and evidence-gated verification** as a human promise — there is no parallel path.

The demo story, end to end:

1. Enable writes on the Claude Desktop entry: `"env": { "RELAY_MCP_WRITES_ENABLED": "1" }`.
2. In Claude Desktop: *"Use Relay to find an open food need, then pledge that the Chennai Food Bank agent will fulfil it."* → `pledge_support` files the proposal; the tool result says a coordinator must confirm.
3. In Slack, the need's card now reads *"🤖 Pledged via MCP by Chennai Food Bank agent — confirm to track it."* A coordinator clicks **✅ Confirm pledge** (the existing human gate) → the pledge becomes a tracked commitment that drifts, is chased, and closes on evidence exactly like a human's.

Every value the tool returns is **PII-free** (as with the read tools) — it echoes only the need's public id and the agent's own org name, never beneficiary contact. The whole accountability chain is proven hermetically by the `agent_pledge` demo capability (`npm run demo`): the agent proposal is not auto-claimed, an agent self-assign is rejected at the gate, a human Assign commits it, and it then drifts + closes on evidence exactly like a human obligation.

### Counterfactual — a measured (SIMULATED) delta, not an adjective (Moonshot #3)

"Structured coordination beats an unstructured group chat" is an adjective until it is a number. `npm run counterfactual` runs a naive **group-chat baseline simulator** (published rules R1–R4 in [`docs/BASELINE-RULES.md`](docs/BASELINE-RULES.md)) **and** drives the identical fictional flood through the real hermetic Relay pipeline, then prints the delta. On `flood-1` (measured, labelled **SIMULATED**, never a claim about a real deployment):

> **SIMULATED flood** — group-chat baseline: **2 unclaimed, 2 double-served, 0 verified** · Relay: **14 needs, 2 deduped, 1 verified**. Delta: **2 double-serves avoided, 2 requests kept owned instead of lost, +1 verified delivery** over the baseline's zero.

Every number comes from **actually running both simulators** on the frozen scenario — nothing is fabricated or tuned to a target. The comparison is also asserted by the `counterfactual` demo capability (`npm run demo`).

### Click-to-audit donor report (Moonshot #6)

Every headline figure in `/relay report` carries a **🔍 Audit** control. A click reveals the **redacted, ledger-derived evidence chain** behind that number — each event shown as its **type, evidence kind, timestamp and actor *role* only** (human / agent / system), never a name, contact, note, actor id, or evidence file reference. It is a **read-only view over the append-only ledger**, PII-free by construction — the proof behind the number, not a separate source of truth. Asserted by the `auditable_report` demo capability (`npm run demo`), which proves the chain is redacted and grep-clean of the seed contacts. Two more sitrep/dispatch garnishes ship alongside it: `/relay sitrep` best-effort uploads a **live operations map** (SVG plotted on the fictional seed gazetteer), and a claimed obligation's card shows a **pre-warmed backup** — the genuine #1 alternative volunteer from the same deterministic scorer — so a reassignment is a one-tap hand-off (advisory only; committing it stays the human-gated reassign click).

## Docs

- `docs/BUILD-DOC.md` — full build document (product spec, state machine, compliance rules)
- `docs/DEPLOY.md` — Fly.io production deploy runbook (`fly.toml`)
- `CLAUDE.md` — engineering invariants (append-only ledger, human gates, PII rules)
- Architecture diagram: `docs/architecture.png` *(added before submission)*

All demo data is fictional. Relay assists volunteer coordinators; it is not an emergency service.

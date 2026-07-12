# Relay — Devpost submission

> Ready-to-paste description. Replace ⟨video URL⟩ and ⟨sandbox URL⟩ before submitting.
> **Track: Slack Agent for Good.** All data in the demo is fictional. Relay assists volunteer coordinators; it is not an emergency service.

**Relay — verified crisis coordination inside Slack. Every need tracked, every promise proven.**

## Inspiration

In the 2015 and 2023 floods in our city, volunteers coordinated rescues and relief over group chats. Requests arrived as forwarded texts, screenshots, and panicked messages across a dozen threads. The same family got rescued twice while another was missed. People said "I'll go" and quietly dropped. Afterward, nobody could tell donors what had actually happened. In a disaster, the deadliest thing is a lost message — and every one of those failures is a *state-tracking* failure. Relay is the coordination layer we wished those volunteers had, built inside the tool they were already living in.

## What it does

Relay runs the full relief loop inside a Slack workspace: **Intake → Triage → Match → Commit → Verify → Report.**

- **Intake** — free-text messages (English and Tamil–English code-mix), turned into structured Need records.
- **Triage** — the agent extracts type, urgency, location, and headcount; separates what was *stated* from what it *inferred*; dedupes; and posts a dispatch card for a human to confirm.
- **Match** — a deterministic scorer suggests the top volunteers by skill, proximity, load, and language; a coordinator assigns in one click.
- **Commit** — every claim becomes a tracked obligation with an SLA. If it drifts, Relay nudges the volunteer, and if they're stuck it proposes a reassignment.
- **Verify** — nothing closes on someone's word. Delivery requires an evidence packet (photo, location, recipient confirmation) and coordinator sign-off for high-severity needs.
- **Report** — a live situation report for coordinators, and a donor-ready impact report where every number links to a ledger event and beneficiary PII never reaches the model.

## Qualifying technologies used

Relay uses **all three**, each with a real job.

- **Slack AI capabilities** — the **Ask-Relay assistant** (Bolt `Assistant`). Opening a thread sets suggested prompts; a question sets a "thinking" status and returns an answer grounded in the PII-free ledger with cited permalinks. It refuses out-of-scope questions and, as a safety behavior, refuses emergency-dispatch questions ("Relay coordinates volunteer relief — it is not an emergency service"). `src/assistant/askRelay.ts`.
- **Real-Time Search (RTS) API** — an `assistant.search.context` client (`src/assistant/rts.ts`), hardened with throttling and retry, grounds Ask-Relay in live field context the ledger doesn't hold. It **lights up when a Slack user token (`xoxp-`) is present** (the `search:read.*` scopes are user-token scopes); without one it degrades to a deterministic mock and answers ledger-only. Results are cited and never persisted, per the API terms.
- **MCP integration** — Relay is **exposed as a read-only MCP server** (`src/mcp-server/`): `search_needs`, `get_need`, `get_sitrep`, over the same PII-free projections the app uses. `npm run mcp` plugs it straight into Claude Desktop, so an external agent can ask "list open critical needs" and get the same numbers as App Home.

## Technological implementation

- **Event-sourced, append-only ledger.** State changes happen only by appending typed events to `need_events`; current state is a projection. Immutability is enforced by a Postgres trigger — a normal `UPDATE`/`DELETE` is rejected ("append-only"), proven in an integration test. A logic change is a replay, not a migration. The audit trail is the product.
- **The LLM proposes; deterministic code decides.** Extraction returns a Zod-validated `NeedDraft`; the pure engine decides every transition. On a validation failure the pipeline runs one repair pass, then routes to `NEEDS_REVIEW` — it never guesses.
- **Humans in command.** Confirm, assign, merge, sign-off, and close all require a human actor; the engine rejects agent/system actors on those transitions rather than trusting the caller. Dedupe auto-*detects* duplicates but the merge itself is a human click.
- **Numbers are never hallucinated.** Sitreps and reports render immutable `{{stat:*}}` tokens computed from the ledger; a validator rejects any digit in the narrative not backed by a stat, regenerating twice before falling back to a deterministic template. Proven: a fabricated figure fed by a mock model never reaches the output.
- **PII minimized by construction.** Beneficiary contact lives only in an AES-256-GCM `contact_vault`; the ledger and every LLM input are zero-copy. A reveal writes an `audit_log` row. The donor report grep-verifies zero seeded phone numbers in its output.
- **Measured, reproducible quality.** On a 40-message labelled set (`npm run eval`): **86.1% field-level extraction accuracy, 100% critical-severity recall, 100% contact/locality accuracy.** Separately, `npm run load` replays the flood's intake through the in-memory pipeline and reports **intake p95 in the low fractions of a millisecond (≈0.1–0.2 ms) at several thousand msg/s** — a *local/hermetic* engine measurement (no Slack/DB/Redis) that varies run-to-run, explicitly not a production SLA.
- **Provider-agnostic LLM.** Claude or OpenAI via one env var; forced tool-use + Zod at the boundary. **Every AI feature falls back to a deterministic extractor/template with no key**, so the whole product — and the offline demo — runs with zero configuration.
- **Tested.** 538 hermetic unit tests (zero infra) + 17 Postgres integration tests. TypeScript strict, event-correlated structured logs.
- **Hosting: Fly.io** — an always-on Docker machine + self-hosted Postgres + Upstash Redis, with auto-HTTPS on `*.fly.dev`. One machine is pinned up so the SLA drift tick and scheduler never sleep and the demo never cold-starts; a deep `/healthz` probe (real pg query + Redis PING) gates rotation, and schema migrations run on boot. The whole product still runs **fully hermetically with zero infra** for `npm test` and the offline demo.

## Design

Relay is a balanced blend of frontend and backend — not a bot that prints text.

- **App Home operations board** — live counters, a "needs your attention" list (open-critical → drifting → at-risk), a drifting-obligations panel, type/severity/locality filters, and a verification-policy + SLA config panel.
- **Dispatch cards** with per-field **stated / inferred / unknown** confidence chips, an evidence checklist, and a reveal-with-audit control.
- **Evidence packets** and a Canvas/Markdown donor report — where **every headline figure carries a 🔍 Audit control** that reveals the *redacted, ledger-derived evidence chain* behind it (event type, evidence kind, time and actor **role** only — never a name, contact, note, or file reference): the proof behind the number, read-only over the append-only ledger.
- **Situational garnishes** — `/relay sitrep` best-effort uploads a **live operations map** (SVG on the fictional seed gazetteer), and a claimed obligation's card shows a **pre-warmed backup** (the genuine #1 alternative from the same deterministic scorer) so a hand-off is one tap.
- **A self-serve judge demo** — `#judges-start-here` → **▶ Run flood demo** plays the full 48-hour scenario (intake → triage → assign → drift → reassign → deliver → sign-off → close) in ~4 minutes, with an idempotent **↺ Reset**.

## Potential impact

Volunteer and mutual-aid organizations already coordinate crisis response in Slack; Relay meets them where they are instead of asking them to adopt a separate platform in the middle of a disaster. The same loop generalizes directly to food banks, blood drives, and search-and-rescue support — anywhere volunteers make promises that need to be tracked and proven. Disaster coordination is life-critical and evergreen. (We make no invented impact statistics here; the only numbers we cite are the measured extraction-accuracy figures above.)

**A measured, SIMULATED counterfactual.** To turn "structured coordination beats an unstructured group chat" from an adjective into a number *honestly*, `npm run counterfactual` runs a naive group-chat baseline simulator (published rules R1–R4 in `docs/BASELINE-RULES.md`) **and** drives the identical fictional flood through the real Relay pipeline, then prints the delta. On `flood-1` — **measured from both runs, labelled SIMULATED, not a claim about any real deployment**: the group-chat baseline leaves **2 unclaimed, 2 double-served, 0 verified**, while Relay tracks **14 needs, dedupes 2, verifies 1** — a delta of **2 double-serves avoided, 2 requests kept owned instead of lost, +1 verified delivery**. Every number comes from actually running both simulators; nothing is fabricated. **And Relay holds AI agents accountable too**: the MCP server carries one opt-in write tool, `pledge_support`, so an external agent can pledge to fulfil a need — but that pledge is a **proposal a human must confirm** through the exact same Assign gate, then it is tracked with the same SLA/drift/evidence as any human promise.

## Quality of the idea / what exists today

Crisis coordination tools exist, but none close this loop *inside the conversation with proof*:

- **Ushahidi / Sahana** are web crisis-mapping platforms that live *outside* the tools volunteers chat in, and they don't track who committed to what or whether it happened.
- **WhatsApp / group chats** are where coordination actually happens today — with zero structure, no dedupe, and no accountability.
- **Slack incident tools (incident.io and similar)** target internal IT incidents and close on status flags, not verified fulfillment.

Relay's wedge: coordination **inside** the conversation, promises tracked as obligations **with proof of delivery**, and donor-grade accountability — an event-sourced ledger, verification gating, and a live judge-runnable simulation that we don't believe any other Good-track entry will have.

## What's next

Slack Connect federation for multi-org shared operations; an SMS/IVR intake bridge for requesters who aren't in Slack; and packaged templates for food banks, blood drives, and SAR support.

## Newly created & distinctness

Relay is a new project created during the submission period (first commit dated after May 20, 2026). It is unique and substantially different from our other entry, **Kept**: Kept tracks B2B customer promises; Relay is humanitarian crisis coordination — different problem, users, UX, and data model. Shared low-level patterns (an RTS client, ledger patterns, a redaction module) are reused as libraries, but Relay is a distinct product.

## Testing instructions

1. Accept the Slack workspace invite (⟨sandbox URL⟩).
2. Open **#judges-start-here** and press **▶ Run flood demo** — a simulated flood response plays out across `#relay-intake → #relay-dispatch → #relay-volunteers → #relay-hq`, narrated by a labelled 🧪 Relay Simulator.
3. Open the **Relay** App Home for the live operations board.
4. Ask the assistant: *"Any critical needs still open?"*
5. Run `/relay sitrep` and `/relay report`.
6. Press **↺ Reset** to replay.

All data is fictional; SLA timers are compressed for the demo. Video: ⟨video URL⟩ · Code, architecture, and eval: https://github.com/indrapranesh/relay-crisis.

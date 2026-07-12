# RELAY — Complete Build Document

**Project:** Relay — the humanitarian coordination layer for Slack
**Track:** Slack Agent for Good · Slack Agent Builder Challenge (slackhack.devpost.com)
**Doc version:** 1.0 · July 4, 2026
**Status:** APPROVED FOR BUILD — internal submission deadline **July 12, 2026, 9:00 PM IST**
**Team:** 3 builders (P1, P2, P3) + P4 joins July 6 if the Soundcheck spike is killed

> **One-liner:** In a disaster, the deadliest thing is a lost message. Relay turns the chaos of volunteer Slack channels into a verified, accountable relief operation: every need captured, every "I'll take it" tracked as a promise, every delivery proven, every donor report backed by evidence.

> **North star (inherited from Kept):** Relay never treats a single message as truth. Needs and commitments live in an event-sourced ledger, verified by evidence, with humans confirming every consequential transition.

---

## 1. What Relay is (and is not)

Relay is a Slack-native agent for volunteer and mutual-aid organizations running crisis response (floods, cyclones, food drives, blood donation, search-and-rescue support). It sits inside the Slack workspace these orgs already coordinate in and runs the full loop:

**Intake → Triage → Match → Commit → Verify → Report**

1. **Intake:** free-text messages (including Tamil/English code-mixed), forms, and forwarded field reports become structured Need records.
2. **Triage:** the agent extracts type, urgency, location, and headcount; separates what was *explicitly stated* from what it *inferred* (InView DNA); dedupes; and posts a dispatch card for human confirmation.
3. **Match:** deterministic scoring suggests the top volunteers by skill, proximity, language, and load; a human assigns, or a volunteer self-claims.
4. **Commit:** every claim becomes a tracked obligation with an SLA timer in an append-only ledger (Kept DNA). Drift triggers nudges and reassignment.
5. **Verify:** closure requires an evidence packet — photo, location, recipient confirmation — and coordinator sign-off for high-severity needs. No "done because someone said done."
6. **Report:** live situation reports for coordinators and a post-event, donor-ready impact report where every number links to ledger events and beneficiary PII is redacted *before* any LLM sees it (ImpactLens DNA).

**Relay is NOT:**
- A public emergency service or a replacement for government EOC systems (positioning must say this explicitly — judges will probe).
- A ticketing tool. Obligations are bidirectional promises with verified fulfillment, not tickets with status flags.
- An autonomous dispatcher. The agent gathers, structures, scores, and proves; humans approve every consequential transition.

**Demo persona org (fictional — see §14 trademark rules):** *"Bay Relief Collective"* — a 120-volunteer mutual-aid group coordinating flood response in a coastal city. All names, phone numbers, and locations in seed data are fictional. (We model the scenario on Chennai's 2015/2023 flood coordination patterns because the team knows them firsthand — this authenticity should come through in the video voiceover, but the org itself stays fictional.)

---

## 2. Hackathon brief — every fact that governs this build

Source: slackhack.devpost.com (overview + official rules, verified July 4, 2026). **Treat this section as compliance law. Re-verify against the live rules page on July 10 in case of amendments.**

### 2.1 Event facts

| Item | Detail |
|---|---|
| Event | Slack Agent Builder Challenge, sponsored by Slack (Salesforce) on Devpost |
| Registered participants | ~2,681 (as of July 4 — expect a fraction to actually submit) |
| Total prize pool | $42,000 |
| Our track | **Slack Agent for Good** — 1st: **$8,000**, 2nd: **$4,000** |
| Achievement prizes (cross-track) | Best UX $2,000 · Most Innovative $2,000 · Best Technological Implementation $2,000 |
| One-prize rule | A submission can win **at most one** prize; track winners are not eligible for achievement prizes. Relay targets 1st in Good; achievement prizes are fallback outcomes, not stacking opportunities. |
| Submission deadline | **July 13, 2026, 5:00 PM PDT = July 14, 5:30 AM IST.** Our hard internal deadline is **July 12, 9:00 PM IST** — never touch the buffer. |
| Judging window | July 14 – August 6, 2026. **The sandbox and hosted app must stay alive, seeded, and demo-ready this entire window.** |
| Winners announced | ~August 11, 2026 |

### 2.2 Eligibility & team rules

- Teams: **up to 4 eligible individuals** per submission. India is an eligible territory. Individuals may be on multiple teams — this is how our group runs Relay and Kept in parallel.
- Relay must be **newly created during the submission period** (which opened May 20, 2026). → **Fresh repo, first commit dated after May 20.** Reusing our own libraries (RTS client from InView, ledger patterns from Kept, redaction module from ImpactLens) is fine, but Relay must be a distinct product.
- Multiple submissions per entrant are allowed but must be **"unique and substantially different"** from each other. Relay vs. Kept: different problem (humanitarian coordination vs. B2B customer promises), different users, different UX, different data model. Include a one-line distinctness statement in the Devpost writeup so judges never wonder.

### 2.3 Technology requirement

Submissions must use **at least one** of: (a) Slack AI capabilities, (b) MCP integration, (c) Real-Time Search (RTS) API. **Relay uses all three** (see §8 for the exact mapping — this is a scoring weapon for Technological Implementation, and the writeup must name all three verbatim).

### 2.4 Required deliverables (Stage One is pass/fail on these — do not die on hygiene)

- [ ] Track selection: **Slack Agent for Good**
- [ ] Text description of features and functionality
- [ ] Demo video: **under 3 minutes**, uploaded public on YouTube/Vimeo, shows Relay actually functioning in Slack, **no copyrighted music, no third-party trademarks or logos** (see §14 production rules). Judges are **not required to watch past 3:00** — the video must land its case early.
- [ ] Architecture diagram (exported PNG in the Devpost gallery + linked full-res)
- [ ] URL to our Slack developer sandbox **with access granted to `slackhack@salesforce.com` and `testing@devpost.com`** — invite both, verify the invites resolved, and keep their access working through August 6.
- [ ] Testing instructions (step-by-step judge script — draft in §13.3)

### 2.5 Judging

- **Stage One:** pass/fail screen — does the submission plausibly meet the requirements above.
- **Stage Two:** four **equally weighted** criteria:
  1. **Technological Implementation** — quality of software development; use of the qualifying technologies.
  2. **Design** — thought-out UX; a *balanced blend of frontend and backend* (in Slack terms: App Home, Block Kit, modals, Canvas — not a bot that only prints text).
  3. **Potential Impact** — on the Slack community and beyond.
  4. **Quality of the Idea** — creativity/uniqueness; if the concept exists, how much does this improve on it.
- Rules note that judging **may use AI-assisted analysis** → the Devpost description must be machine-legible: explicit headers mapped to the four criteria, qualifying technologies named verbatim, claims stated plainly (see §15.2 skeleton).

---

## 3. Strategy — how Relay wins each criterion

**Why this track:** "New Slack Agent" is where all ~2,681 registrants' default ideas land; "Organizations" is Kept's. "For Good" typically draws fewer, softer entries (awareness bots, donation reminders) — a hard-engineering entry with a visceral demo is unusual in this field. Our thesis: *most Good-track entries will be thin; almost none will have an event-sourced ledger, verification, and a live judge-runnable simulation.*

**Criterion → how we score it:**

- **Technological Implementation:** all three qualifying technologies with real jobs (§8); event-sourced ledger with idempotent processing; deterministic-first pipeline with schema-validated LLM outputs; an eval harness with published extraction-accuracy numbers (§10.5); Relay exposed *as an MCP server* so external agents can query needs — a flourish very few teams will attempt.
- **Design:** App Home operations dashboard, dispatch cards with confidence flags, evidence modals, Canvas sitreps — plus the `#judges-start-here` self-serve demo (§13). Target the Best UX crossover as a side effect.
- **Potential Impact:** disaster coordination is life-critical and evergreen; volunteer orgs already live in Slack (e.g., disaster-relief and civic-tech communities famously coordinate there); the template generalizes to food banks, blood drives, and SAR support. Frame impact qualitatively + our measured accuracy numbers. **Do not invent statistics** — judges can smell fabricated impact math, and it violates our own verified-numbers ethos.
- **Quality of the Idea ("does this exist?"):** answer preemptively in the writeup. Ushahidi/Sahana are web crisis-mapping platforms *outside* the tools teams chat in, with no obligation tracking. WhatsApp groups have zero structure. Slack incident tools (incident.io et al.) target internal IT incidents, not humanitarian ops, and close on status flags rather than verified fulfillment. **Relay's wedge: coordination inside the conversation + promises with proof + donor-grade accountability.**

**The one sentence a judge should retell:** *"It caught that the food delivery never actually happened — the volunteer got stuck — and reassigned it before the coordinator even noticed."*

---

## 4. Users, problem, and the demo scenario

### 4.1 Personas

1. **Coordinator (dispatcher)** — runs `#relay-dispatch`. Drowning in unstructured reports; needs triage, matching suggestions, drift alerts, and a live board. *Primary demo protagonist.*
2. **Intake operator** — relays field reports (calls, forwarded texts) into `#relay-intake`, often verbatim and code-mixed.
3. **Volunteer** — claims tasks in `#relay-volunteers`, reports delivery from the field with a photo and location.
4. **Org lead** — needs sitreps during the event and a defensible impact report for donors after it.

### 4.2 The problem, concretely

During flood response, requests arrive as screenshots, forwarded texts, and panicked messages across multiple channels. The same family gets rescued twice while another is missed. Volunteers say "I'll go" and silently drop. Nobody can answer "what's still open in Velachery?" Afterward, the org can't tell donors what verifiably happened. Every failure above is a *state-tracking* failure — which is exactly what an event-sourced agent fixes.

### 4.3 Demo scenario — "48 hours, compressed to 3 minutes"

Fictional flood in Bay Relief Collective's city. Scripted beats (full injector spec in §12):

- **T0:** 14 intake messages flood in over ~40s (mixed English + Tamil-English, duplicates included).
- **T1:** Relay triages: 11 needs created, 2 duplicates merged pending confirmation, 1 flagged low-confidence for human review.
- **T2:** Coordinator confirms the urgent medical need; Relay suggests 3 volunteers; coordinator assigns; volunteer claims a food-delivery need directly.
- **T3 (hero moment):** a claimed delivery drifts past its SLA — volunteer stuck. Relay nudges, gets "can't make it," proposes reassignment; second volunteer delivers, submits photo + location + recipient confirmation; coordinator sign-off closes it with a full evidence trail.
- **T4:** `/relay sitrep` posts the live picture to `#relay-hq` and updates the ops Canvas. Someone asks the Relay assistant, "any urgent medical needs still open near Velachery?" — grounded, cited answer.
- **T5:** `/relay report` drafts the donor impact report: verified numbers only, each linked to its ledger event, PII redacted.

---

## 5. Scope

### 5.1 P0 — must exist for the demo to work (feature-freeze gate)

| ID | Feature | One-line acceptance test |
|---|---|---|
| F1 | Intake & triage pipeline | 14 scripted messages → ≥11 correct Need cards in dispatch, dupes proposed, low-confidence flagged |
| F2 | Needs Board (App Home + dispatch cards) | Coordinator can see, filter, confirm, assign, merge from Slack alone |
| F3 | Volunteer registry & matching | `/relay volunteer` onboarding modal; top-3 suggestions with scores + rationale |
| F4 | Obligation ledger + SLA + drift | Claim → timer → nudge → reassign flow works end-to-end; ledger is append-only |
| F5 | Verification & evidence closes | Close blocked until photo + location + recipient confirm; coordinator sign-off for high severity |
| F6 | Sitrep | `/relay sitrep` posts accurate numbers (computed in code, narrative by Claude) + Canvas update |
| F7 | Impact report | `/relay report` → PII-redacted, ledger-linked draft |
| F8 | Judge experience | `#judges-start-here` with buttons: Run flood demo · Reset · Guided tour |

### 5.2 P1 — build if on schedule July 9

- Relay **as an MCP server** (read-only: `search_needs`, `get_sitrep`) — big Tech-Implementation points, demoable from Claude Desktop in the video's last act.
- Ask-Relay assistant thread with RTS-grounded, permalink-cited answers (if RTS quota/setup fights us, fall back to ledger-only answers and say so honestly).
- Reply-in-requester's-language templates.

### 5.3 P2 / explicitly OUT of scope (say "roadmap" in the video, build nothing)

- WhatsApp/SMS bridges, public intake forms outside Slack, offline mode.
- Slack Connect multi-org federation (mention as roadmap — it's the natural sequel).
- Auto-assignment without human click. Never build this; it's against the thesis.
- Real routing/ETA math, payments, inventory management.

### 5.4 Cut lines if behind (in order)

Language-matched replies → Canvas updates (keep message sitreps) → Ask-Relay RTS grounding (keep ledger answers) → MCP server → merge-suggestion UI (keep exact-contact auto-link only). **Never cut:** the ledger, verification, the drift-reassign hero moment, App Home, or the judge demo runner — the demo dies without them.

---

## 6. Core loop — state machine & event taxonomy

### 6.1 Need lifecycle (states)

`NEW → TRIAGED → OPEN → MATCH_SUGGESTED → CLAIMED → IN_PROGRESS → DELIVERED_UNVERIFIED → VERIFIED → CLOSED`
Side paths: `NEEDS_REVIEW` (low confidence), `DUPLICATE(mergedInto)`, `EXPIRED`, `REOPENED`, `CANCELLED`.

### 6.2 Rules that make Relay *Relay*

1. State changes happen **only** by appending typed events; current state is a projection. No `UPDATE needs SET status=...` anywhere.
2. **Consequential transitions require a human actor event:** confirm-triage (if low confidence or severity=critical), assign, merge, verify-close, cancel. Agent/system events do everything else (extract, score, nudge, timer-expire, evidence-attach).
3. **Verification levels:** L0 self-report · L1 photo+location · L2 recipient confirmation · L3 coordinator sign-off. Policy: severity `critical|high` closes at **L3 with L1+L2 evidence attached**; `medium|low` at L2. Policy lives in config, shown in App Home.
4. Every LLM output that touches state is schema-validated; on validation failure → `NEEDS_REVIEW`, never a guess.
5. Every card the agent posts shows **stated vs. inferred vs. unknown** fields (InView DNA) with confidence chips.

### 6.3 Event taxonomy (append-only `need_events`)

`NeedCreated, ExtractionCompleted, DuplicateProposed, DuplicateConfirmed, TriageConfirmed, MatchSuggested, Claimed, Assigned, Nudged, ClaimReleased, Reassigned, EnRouteReported, EvidenceAttached{kind}, RecipientConfirmed, CoordinatorSignedOff, Verified, Closed, Reopened, Expired, Cancelled, CommentAdded` — each with `actor_type: human|agent|system`, `actor_id`, `payload jsonb`, `ts`. The impact report and sitreps read **only** from this table. This is the audit trail judges will love.

---

## 7. Feature specs & acceptance criteria

### F1 — Intake & triage

- **Sources:** any message in `#relay-intake` (event subscription), `/relay need` modal, DM to the bot. Bulk paste (multi-line forwarded text) is split into candidate needs.
- **Pipeline:** `message` event → queue → language ID → Claude extraction to `NeedDraft` JSON (schema in Appendix C) → deterministic validators (phone regex, known-locality gazetteer for geocoding, severity keyword floor: words like "trapped/drowning/dialysis/child" can raise severity, never lower it) → dedupe pass → post dispatch card.
- **Dedupe:** exact contact-number match auto-links (deterministic). Otherwise embedding cosine ≥ 0.86 within same type + ~2km + 24h → `DuplicateProposed` card for human merge. Never auto-merge on similarity alone.
- **Geocoding:** gazetteer of ~40 seeded localities with lat/lng (fictional city grid mapped onto real Chennai-like geometry); free-text fallback stores `location_text` unresolved and flags it. No external geocoding dependency for the demo.
- **Acceptance:** on the 40-message eval set (§10.5): ≥85% field-level extraction accuracy; **≥95% recall on severity=critical**; zero auto-merged false duplicates; p95 message→card < 15s (streaming "triaging…" placeholder immediately, then `chat.update`).

### F2 — Needs Board

- **Dispatch card (Block Kit):** header `N-0421 · MEDICAL · CRITICAL 🔴`, fields (location, people, source permalink, contact hidden behind reveal-with-audit button), confidence chips per field (`stated ✓ / inferred ~ / unknown ?`), actions: **Confirm · Assign · Merge · Edit · Escalate**.
- **App Home:** live counters (Open / Claimed / In-progress / Delivered-unverified / Verified today), urgent-list, "drifting obligations" section, filter buttons (type/severity/locality), config panel (verification policy, SLA table), and a "How Relay decides" transparency note.
- **Acceptance:** every state in §6.1 is reachable and visible from Slack alone; App Home reflects ledger within 5s of any event.

### F3 — Volunteer registry & matching

- Onboarding modal: skills (multi-select: boat, medical, driver, cooking, translation, tech, muscle), home locality, radius, capacity/day, languages, availability windows. Stored per Slack user; editable anytime; `/relay volunteers` lists the roster for coordinators.
- **Matching = deterministic scoring, LLM explains:** `score = 0.35·skill + 0.25·proximity_decay + 0.15·availability + 0.15·(1−load_ratio) + 0.10·language`. Top-3 posted with score breakdown bars; Claude writes the one-line rationale ("Priya: paramedic, 1.2 km away, free now, speaks Tamil"). Fallback button: **Broadcast to #relay-volunteers** for open claim.
- **Acceptance:** suggestions render < 3s; rationale never contradicts the score inputs (validator checks names/facts against the scored rows).

### F4 — Obligation ledger, SLA & drift

- Claim/assign creates an `Obligation` with `sla_due_at` from a per-type table (critical medical: 45 min; food: 4 h; shelter: 8 h — config, not code).
- Drift engine (worker, 60s tick): T-25% remaining → DM nudge with **On my way / Delayed / Release** buttons; overdue → dispatch-card flare + reassignment proposal with fresh top-3. "Delayed" asks for a new ETA (bounded); two delays → auto-propose reassign (human confirms).
- **Acceptance:** the full hero sequence (claim → drift → release → reassign → deliver) runs unattended off the injector's compressed clock (§12.3).

### F5 — Verification & evidence

- Volunteer flow (DM or thread): **Mark delivered** → modal collects photo upload + locality confirm + optional note → Relay posts a recipient-confirmation prompt (requester's thread gets a ✅ button; if requester unreachable, coordinator may substitute with reason — logged).
- Evidence packet renders in the need thread: photo (Slack file), location, timestamps, confirmations. Coordinator **Sign off & close** button appears only when policy is satisfied; otherwise the button is disabled with a "missing: recipient confirmation" hint.
- **Do not rely on photo EXIF GPS** — Slack strips/re-encodes uploads unreliably; locality confirm is an explicit button/select, not metadata magic.
- **Acceptance:** closing without required evidence is impossible via any UI path; every close renders a linkable evidence trail.

### F6 — Sitreps

- `/relay sitrep` (and a scheduled 6h job): aggregates computed in SQL → numbers injected as immutable `{{stat:*}}` tokens → Claude writes the narrative around them → post-generation validator rejects any digit not present in the token map (regeneration on failure, max 2, then plain-stats fallback). Posts to `#relay-hq` + updates the ops **Canvas** (P0 = message; Canvas = keep-if-on-schedule within F6).
- **Acceptance:** numbers in narrative == numbers in SQL, always; sitrep generation < 20s.

### F7 — Impact report (ImpactLens DNA)

- `/relay report [period]` → pipeline: ledger query (verified events only) → **PII redaction pass (deterministic: names, phones, exact addresses → tokens) BEFORE any LLM call** → Claude drafts donor narrative → every claim annotated with ledger-event references → renders as Canvas + downloadable Markdown. Numbers use the same immutable-token validator as F6.
- **Acceptance:** grep of the generated report finds zero seeded phone numbers/names; every statistic carries an event-reference footnote.

### F8 — Judge experience (see §13)

Buttons in `#judges-start-here`: **▶ Run flood demo** (fires injector), **↺ Reset demo**, **🧭 Guided tour** (posts a 6-step walkthrough with deep links), **📄 Architecture** (posts the diagram + repo link). Idempotent, multi-run safe.

---

## 8. Slack surface map & qualifying-technology proof

**This table goes (adapted) into the Devpost writeup — it is our Technological Implementation evidence.**

| Qualifying technology | Where it lives in Relay | Demo proof point |
|---|---|---|
| **Slack AI capabilities** (Agents & AI Apps in Bolt JS) | The **Assistant pane** (`app.assistant(new Assistant(…))`, `src/ingest/slackApp.ts`): `assistant_thread_started` sets the manifest suggested prompts; a user message calls `setStatus('Reading the ledger…')` then **Ask-Relay** (`src/assistant/askRelay.ts`, prompt P-7) and replies with a grounded, cited, PII-free answer — or a scope refusal | Open Relay's Assistant, ask "any critical needs still open?" → it names the open criticals from the ledger, no PII; ask something off-topic → it refuses |
| **Real-Time Search (RTS) API** | Ask-Relay grounding: the hardened `RtsClient` (`src/assistant/rts.ts`, ported from InView + throttle/retry) wraps `assistant.search.context` to pull field context the ledger lacks and cites the returned permalinks. Wired into the assistant; **lights up when a user token (`SLACK_USER_TOKEN`, xoxp-) is configured** (the `search:read.*` scopes are user-token scopes) | With a user token: an answer about a locality cites a message permalink retrieved via RTS. **Without one it falls back to the deterministic mock and answers ledger-only** — RTS results are never persisted (ToS) |
| **MCP integration** | Relay **exposes a read-only MCP server** (`src/mcp-server/`) with `search_needs`, `get_need`, `get_sitrep` over the same PII-free projections the app uses (never the vault). `npm run mcp` runs it over stdio for Claude Desktop; the factory is transport-agnostic (HTTP mount is a documented seam) | Claude Desktop configured with the Relay MCP server (README snippet) asks for open critical needs; the numbers match App Home / `/relay sitrep` |

Other Slack platform surfaces used: Events API (`message.{channels,groups,im}`, `app_home_opened`, `assistant_thread_started`/`assistant_thread_context_changed` — the shipped subscriptions; `app_mention`/`reaction_added` were dropped in the 2026-07-07 audit, see §9.3), Block Kit (cards, confidence chips), modals (`views.open`), App Home (`views.publish`), slash command `/relay` (incl. `/relay demo start|reset` for the judge flow), DMs, threads + permalinks, file uploads for evidence, Canvas API for sitreps/reports.

**Shipped status (Jul 10, honesty rule).** All three qualifying technologies are wired into the running app: the Assistant pane + Ask-Relay (Slack AI) and the read-only MCP server are fully demonstrable with zero external services; RTS grounding is implemented and hardened but only exercises live Slack search when a `SLACK_USER_TOKEN` is present — absent that token it degrades to ledger-only answers via the mock (so the row stays honest either way). **If RTS cannot be shown live in the sandbox, state exactly this in the writeup rather than implying a live RTS demo.** Judges poke sandboxes.

---

## 9. Architecture

### 9.1 Components

```
Slack workspace (sandbox)
   │  Events API / interactivity / slash (HTTP mode)
   ▼
Bolt-JS app (Node + TypeScript, single service "relay-core")
   ├─ ingest/        Slack event handlers → enqueue, ack < 3s always
   ├─ pipeline/      extraction · validation · dedupe · geocode (BullMQ workers)
   ├─ ledger/        event store + projections (Postgres, append-only)
   ├─ match/         deterministic scorer + rationale generator
   ├─ drift/         SLA timers, nudges, reassignment proposals (60s tick)
   ├─ narrate/       sitrep + impact-report generators (token-validated)
   ├─ surfaces/      Block Kit builders · App Home · modals · Canvas
   ├─ assistant/     AI-app assistant threads · RTS client (from InView)
   ├─ mcp-server/    read-only MCP endpoint (P1)
   └─ demo/          injector · reset · judge-tour handlers
Postgres 16 (+ pgvector for dedupe embeddings) · Redis (BullMQ)
Anthropic API (Claude) · Slack Web API
Hosting: Fly.io (always-on Docker machine `min_machines_running=1` + self-hosted Fly Postgres + Upstash Redis, auto-HTTPS on `*.fly.dev` — see `fly.toml` + `docs/DEPLOY.md`; the AWS CDK in `infra/` is archived as a portable alternative because AWS is account-restricted) · UptimeRobot on /healthz (deep probe: `GET /healthz` actually queries Postgres + PINGs Redis and returns 503 when a wired dependency is down, so a dead pg/redis pulls the machine from rotation instead of reporting a static 200). Schema migrations run on boot (`runStartupMigrations`, advisory-locked + idempotent) before the app serves; a migration failure exits non-zero so a schema-less machine never takes traffic.
```

### 9.2 Non-negotiable engineering rules

1. **Ack fast, work async.** Every Slack handler acks < 3s; all LLM work is queued; placeholders update via `chat.update`.
2. **Idempotency everywhere.** Slack retries events; dedupe on `event_id`/`client_msg_id` (unique index) before enqueue.
3. **Rate-limit respect:** ~1 msg/s/channel budget for `chat.postMessage` — the injector and drift engine share a per-channel token bucket.
4. Verify Slack signatures; secrets in platform env vars; least-privilege scopes; demo data flagged `is_demo` for clean resets.
5. TypeScript strict; Zod schemas at every LLM and Slack boundary; structured logs (pino) with event correlation IDs — screenshot-worthy for the "quality of software development" criterion.

### 9.3 OAuth scopes (justify each in the writeup; add nothing speculative)

`assistant:write, canvases:read, canvases:write, channels:history, channels:read, chat:write, chat:write.customize, commands, files:read, files:write, groups:history, groups:read, im:history, im:read, im:write, users:read` — the exact set in `manifest.{dev,prod}.yaml`. Reconciled 2026-07-07 against actual call sites + registered handlers: **removed `app_mentions:read`, `reactions:read`, `reactions:write`** (Relay registers no `app_mention`/`reaction_added` handler and makes no `reactions.*` call — honesty rule). `groups:*` are kept deliberately: `resolveRoles()` lists `private_channel` and `app.message()` handles private-channel intake (the intake channel may be private for PII reasons). `assistant:write` verified against inview's working manifest; `chat:write.customize` lets the F8 judge injector post the flood under the labelled "Relay Simulator 🧪" identity — CLAUDE.md 10. RTS `search:read.*` scopes are **user-token** scopes (see `../inview/docs/DECISIONS.md`).

### 9.4 Data model

See `db/migrations/001_init.sql` (raw SQL is the contract; raw `pg` driver, no ORM — kept convention): `channel_configs` · `needs` (status = projection) · `need_events` (append-only, trigger-enforced) · `volunteers` · `obligations` · `evidence` · `contact_vault` (PII only here, AES-256-GCM) · `sitreps` · `localities` · `audit_log` · `slack_events` (transport dedupe).

### 9.5 App manifests

`manifest.dev.yaml` (Socket Mode, local dev) · `manifest.prod.yaml` (HTTP mode, request URLs = the Fly host `https://relay-crisis.fly.dev/slack/events` — see `docs/DEPLOY.md`).

---

## 10. LLM design

### 10.1 Prompt inventory (all return JSON validated by Zod; files in `src/llm/prompts/`)

| # | Prompt | Model | Notes |
|---|---|---|---|
| P-1 | Intake extraction (multilingual, few-shot incl. Tamil-English code-mix) | Sonnet | The quality-critical one; temperature 0; returns `NeedDraft` + per-field `stated\|inferred\|unknown` provenance |
| P-2 | Bulk-paste splitter | Haiku | Segments forwarded blobs into candidate needs |
| P-3 | Dedupe adjudication | Haiku | Given 2 candidates + context → same-incident probability + reason (advisory; humans confirm) |
| P-4 | Match rationale | Haiku | One line per suggested volunteer; validator forbids facts absent from scorer input |
| P-5 | Sitrep narrative | Sonnet | Writes around immutable `{{stat:*}}` tokens |
| P-6 | Impact-report narrative | Sonnet | Input is already PII-redacted; event-reference annotations required |
| P-7 | Ask-Relay synthesis | Sonnet | Ledger rows + RTS snippets → cited answer; must refuse outside scope ("I track relief ops, not general questions") |

### 10.2 Reliability pattern (uniform)

`try model → Zod parse → on fail: one repair pass with error appended → on fail: NEEDS_REVIEW + human card`. Log every parse failure; the count goes in our writeup ("<2% needs-review rate on eval set" — measure, don't claim blind).

### 10.3 Language handling

P-1 few-shots include transliterated Tamil-English like *"Velachery la 3 families terrace mela irukanga, thanni yeruthu, food venum urgent"* → extraction must yield `type=food, severity=high, locality=Velachery, people≈3 families, stated:[location,need,people], inferred:[severity]`. If eval accuracy on code-mixed set < 80% by July 8, the demo script leans on the English-majority path and code-mix becomes one showcased example rather than half the injector set (decision gate, not hope).

### 10.4 Cost & latency budget

Demo-scale volumes are trivial (hundreds of calls/day). Budget ceiling $50 for the whole window; Haiku for high-volume classify/segment, Sonnet for extraction + narratives. Pre-warm before video takes and judge hours; p95 targets: extraction < 8s, sitrep < 20s.

### 10.5 Eval harness (Best-Tech-Implementation ammo)

`eval/intake_set.jsonl`: 40 labeled messages (24 English, 10 Tamil-English, 6 noisy/dupes) — written day 1, frozen day 2. `npm run eval` prints field-level accuracy, critical-severity recall, dedupe precision. Numbers go verbatim into the writeup and one architecture-slide overlay in the video. If a number is bad, we fix or we publish it honestly with the mitigation.

---

## 11. Privacy, safety & ethics (a scoring section for a "for Good" judge, not boilerplate)

1. **PII minimization:** beneficiary contacts live only in `contact_vault`; cards show a reveal button that writes an audit event; LLM narrative pipelines receive redacted tokens only (deterministic redaction *before* the API call — ImpactLens module reused).
2. **No fabricated urgency, ever:** severity floors are keyword-deterministic and can only raise; the model cannot downgrade a "trapped/child/dialysis" message.
3. **Human authority:** every consequential transition is human-confirmed; the App Home "How Relay decides" note states this in plain language. Relay assists coordinators; it does not dispatch emergency services and says so if asked (P-7 refusal behavior).
4. **Simulation honesty:** all demo traffic is posted by a visibly-labeled "Relay Simulator" identity with a 🧪 prefix — judges must never wonder whether the flood is real.
5. **Data lifecycle:** `is_demo` purge on reset; retention note in README; no analytics/tracking of workspace members beyond operational events.
6. **Failure honesty:** every card shows confidence; unknown fields say "unknown," never a guess. This is the InView lesson productized.

---

## 12. Seed data & demo injector

### 12.1 Workspace layout (sandbox)

`#relay-intake` · `#relay-dispatch` · `#relay-volunteers` · `#relay-hq` · `#judges-start-here` · DM threads. Seeded: 12 volunteer profiles (varied skills/localities/languages), 40-locality gazetteer, 3 days of light historical chatter so RTS answers have texture, verification policy config.

### 12.2 Scripted injector

`demo/scenarios/flood-1.yaml`: ordered messages with `delay_ms` jitter, persona display names, language tags, expected outcomes (used by the smoke test). Runs via button or `/relay demo start flood-1`. Posts as **Relay Simulator 🧪**. Includes: 14 intake messages (2 exact-contact dupes, 1 fuzzy dupe, 1 garbled low-confidence, 3 Tamil-English), 2 volunteer claim actions, 1 scripted "Delayed→Release" reply to drive the hero reassignment.

### 12.3 Compressed clock

Injector runs set `sla_multiplier=0.02` on demo obligations (45-min SLA → ~54s) so drift fires on camera and for judges. Multiplier is config, labeled in `#judges-start-here` ("SLAs compressed for demo").

### 12.4 Reset

`/relay demo reset`: archive demo cards, purge `is_demo` rows, republish App Home, repost tour. Idempotent; < 30s; tested 10+ times before submission.

---

## 13. Judge experience & testing instructions

### 13.1 Principle

Judges evaluate dozens of projects July 14–Aug 6. Most sandboxes they enter will be dead or confusing. Ours must be a **self-driving demo**: one channel, one button, three minutes to the full story — with everything resettable so the 9th judge sees what the 1st saw.

### 13.2 Ops during judging window

- Hosting always-on; UptimeRobot pings `/healthz` every 5 min → alert to our phones; daily manual smoke run (calendar owner: P1).
- Do-not-touch policy on `main` after July 12 except hotfixes via the two-person rule.
- Both judge emails invited to the workspace **and** verified joined; re-check July 13, July 20, August 1.

### 13.3 Testing-instructions text (paste into Devpost, adjust links)

> 1. Accept the Slack workspace invite (sent to slackhack@salesforce.com / testing@devpost.com). 2. Open `#judges-start-here` and press **▶ Run flood demo** — a simulated 48-hour flood response plays out in ~4 minutes across `#relay-intake` → `#relay-dispatch` → `#relay-volunteers` → `#relay-hq`. 3. Open the **Relay** App Home for the live operations board. 4. Try the assistant: ask *"Any critical needs still open?"* 5. Run `/relay sitrep` and `/relay report`. 6. Press **↺ Reset** to replay. All data is fictional; SLA timers are compressed for demo purposes. Architecture, eval numbers, and code: https://github.com/indrapranesh/relay-crisis.

---

## 14. Demo video — storyboard & production rules

### 14.1 Rules (compliance)

Under 3:00 (target 2:45); public YouTube; screen-recorded real product (no mockups passed off as working); **royalty-free music only** (keep the license file); **no third-party trademarks/logos** — the cold-open "chaos" montage uses a *generic* messaging UI we mock ourselves, never a real WhatsApp screenshot; no real names/photos; Slack itself obviously appears (it's the sponsor platform). Judges may stop at 3:00 — the case must be made by 2:00.

### 14.2 Shot-by-shot (2:45)

| Time | Screen | Voiceover beat |
|---|---|---|
| 0:00–0:18 | Generic chat chaos mock → hard cut to black | "In the 2015 floods, volunteers in our city coordinated rescues over group chats. Messages scrolled away. People got missed. **In a disaster, the deadliest thing is a lost message.**" |
| 0:18–0:35 | `#relay-intake` — injector fires 14 messages incl. Tamil-English; dispatch cards materialize with confidence chips | "Relay reads the flood of messages — any language, any format — and turns each into a tracked, deduplicated need. It shows what was said, what it inferred, and what it doesn't know." |
| 0:35–1:00 | Coordinator confirms critical medical need; top-3 match with score bars; assign | "Humans stay in command. Relay suggests the right volunteer — skill, distance, language, load — a coordinator decides in one click." |
| 1:00–1:40 | **Hero:** SLA drifts, nudge DM, "can't make it," reassignment card, second volunteer delivers → photo + locality + recipient ✅ → sign-off → evidence trail | "Every 'I'll take it' becomes a promise Relay tracks. When this one drifted, Relay caught it and re-routed — and nothing closes on someone's word alone. Delivery is **proven**: photo, location, recipient confirmation." |
| 1:40–2:05 | `/relay sitrep` + Canvas; App Home board | "Coordinators get a live, verified picture — not vibes." |
| 2:05–2:25 | Ask-Relay cited answer; then Claude Desktop querying Relay's MCP server | "Any agent can ask Relay what's true on the ground — it's an MCP server too." |
| 2:25–2:45 | `/relay report` donor report with event-linked numbers → architecture flash with the three technologies labeled → logo | "After the water recedes: a donor report where every number carries proof, and no beneficiary's identity ever reached the AI. Built on Slack AI, the Real-Time Search API, and MCP. **Relay — every promise, kept, when it matters most.**" |

### 14.3 Production plan

Script locked July 10 eve · shot July 11 PM in a clean workspace at 1920×1080, cursor highlighted, injector pre-warmed · 2 full takes per segment · edit July 12 AM (DaVinci/CapCut) · captions burned in (judges skim muted) · upload unlisted July 12 noon for team review, **public by July 12, 6 PM IST**.

---

## 15. Devpost submission package

### 15.1 Field-by-field checklist (owner: P3 · done by July 12, 8 PM IST)

- [ ] Project name **Relay**, tagline: *"Every promise, kept, when it matters most — verified crisis coordination inside Slack."*
- [ ] Track: **Slack Agent for Good**
- [ ] Description: skeleton in §15.2, criteria-mapped headers, technologies named verbatim
- [ ] Video URL (public, < 3:00) — plays in incognito ✓
- [ ] Architecture diagram uploaded (PNG in gallery + full-res link)
- [ ] Sandbox URL + both judge emails invited & verified + §13.3 instructions pasted
- [ ] Repo link (public, MIT, README with 60-second local setup, eval instructions, first commit > May 20 ✓)
- [ ] Team: ≤ 4 members listed; distinctness statement vs. our other submission(s)
- [ ] "Built with" tags: slack, bolt-js, anthropic-claude, mcp, rts-api, postgres, typescript…
- [ ] Screenshot gallery: dispatch card, App Home, evidence trail, impact report, architecture
- [ ] Submitted on Devpost by **July 12, 9 PM IST**; confirmation email archived; re-verify rules page for amendments July 10

### 15.2 Writeup skeleton (machine-legible for AI-assisted judging)

`## Inspiration` (2015/2023 flood coordination, first-person) → `## What it does` (the six-verb loop) → `## Qualifying technologies used` (the §8 table: **Slack AI capabilities, Real-Time Search API, MCP**) → `## Technological implementation` (event-sourced ledger, deterministic-first, eval numbers, MCP server) → `## Design` (App Home, confidence chips, judge demo runner) → `## Potential impact` (crisis orgs on Slack; generalizes to food banks/blood drives; qualitative + measured claims only) → `## Quality of the idea / what exists today` (Ushahidi/Sahana/WhatsApp/incident-tools contrast) → `## What's next` (Slack Connect federation, SMS bridge) → `## Newly created & distinctness statement`.

---

## 16. Team plan — 9 days

### 16.1 Roles

- **P1 — Platform & Ledger:** Bolt skeleton, infra/hosting, event store, drift engine, injector, uptime. *Owns: demo never dies.*
- **P2 — Intelligence:** extraction pipeline, dedupe, matching, eval harness, sitrep/report generators, Ask-Relay + RTS, MCP server (P1 item). *Owns: the numbers we publish.*
- **P3 — Experience & Story:** Block Kit/App Home/modals/Canvas, judge channel, video script+shoot+edit, Devpost package, diagram. *Owns: what judges actually see.*
- **P4 (if Soundcheck dies July 5):** joins P3 for judge UX + screenshots, then QA/bug-bash lead.

### 16.2 Schedule (IST; feature freeze July 10, 9 PM)

| Date | Milestone (end of day) |
|---|---|
| **Jul 4** | Repo + CI + hosting live; app manifest installed in sandbox; channels seeded; **scenario script + eval set drafted**; walking skeleton: intake message → dumb card round-trip |
| **Jul 5** | M1: extraction v1 behind queue (Eng only); ledger events writing; App Home stub; injector v1 plays 5 messages. *Soundcheck go/no-go tonight.* |
| **Jul 6** | Dedupe + gazetteer + confidence chips; dispatch actions (confirm/assign); volunteer onboarding modal |
| **Jul 7** | **M2: core happy path e2e** — inject → triage → match → claim → deliver(L0) → close; eval run #1, fix worst extraction bugs |
| **Jul 8** | Evidence flow (photo/locality/recipient/sign-off) + close-gating; SLA/drift engine; *code-mix quality gate decision* |
| **Jul 9** | **M3:** sitrep + token validator + Canvas; impact report w/ redaction; App Home full board; start P1 items (MCP server, RTS grounding) |
| **Jul 10** | Judge channel + reset + tour; polish pass; **9 PM FEATURE FREEZE**; full dress rehearsal ×2; video script locked |
| **Jul 11** | AM bug-bash on frozen build (P4 leads) · PM **video shoot**; architecture diagram final |
| **Jul 12** | AM edit + captions · noon internal review · **6 PM video public · 8 PM Devpost fields done · 9 PM SUBMIT** |
| **Jul 13** | Buffer only: verify judge invites, uptime, video plays logged-out. No deploys. Deadline 5 PM PDT = **Jul 14, 5:30 AM IST** — we are 32h early by design |

### 16.3 Working agreements

Daily 10:00 sync (15 min) + 21:30 demo-path run · the **demo path is sacred**: any post-freeze commit needs two approvals · every feature lands with its injector-scenario coverage · cut-line order in §5.4 is pre-agreed so schedule slips trigger cuts, not debates.

### 16.4 Risk register

| Risk | L×I | Mitigation |
|---|---|---|
| RTS access/quota friction in fresh sandbox | M×M | Reuse InView client + creds pattern day 1; fallback: ledger-grounded Ask-Relay, remove RTS row from §8 table (honesty rule) |
| Assistant scope names drift | M×L | Resolved day 1 — scopes verified against inview's working manifest |
| Tamil-English extraction < 80% | M×H | §10.3 decision gate Jul 8; English-led demo path ready |
| Slack rate limits garble injector | M×M | Shared token bucket; 40s spread; rehearsed ×10 |
| Live-demo LLM latency on camera | H×M | Pre-warm; placeholder→update pattern reads as "thinking"; video allows retakes; judges get compressed SLAs not live LLM races |
| Hosting sleeps mid-judging | L×H | Fly always-on (`min_machines_running=1`, `auto_stop_machines=false`) + UptimeRobot on `/healthz` + daily smoke calendar |
| Photo GPS assumptions fail | H×M | Designed out — explicit locality confirm (§F5) |
| Scope creep past freeze | H×H | Freeze ritual + two-person rule + cut lines |
| Devpost/deadline-day outage | L×H | Submit Jul 12; confirmation archived |

---

## 17. Post-hackathon roadmap (one video line + writeup section, zero build)

Slack Connect federation (multi-org shared ops), SMS/IVR intake bridge for non-Slack requesters, templates for food banks / blood drives / SAR support, verified-skill badges, offline-tolerant field client.

---

## Appendix C — P-1 intake-extraction prompt (draft)

```
SYSTEM
You extract structured relief needs from raw messages sent to a volunteer
coordination channel. Messages may be in English, Tamil, or Tamil-English
code-mix (transliterated). Return ONLY JSON matching the schema. For every
field, record provenance: "stated" (explicit in the message), "inferred"
(reasonable deduction — explain briefly), or "unknown". Never guess contact
details. Severity ∈ {critical, high, medium, low}; if unsure between two,
choose the higher. Do not translate names of places; normalize them against
the provided locality list when confident.

SCHEMA
{ "type": "medical|rescue|food|water|shelter|transport|other",
  "severity": "...", "locality_guess": "...", "location_text": "...",
  "people_count": int|null, "contact_raw": string|null,
  "summary_en": "...", "languages": ["ta","en"],
  "provenance": { "<field>": {"status":"stated|inferred|unknown","why":"..."} } }

FEW-SHOT 1 (code-mix)
IN: "Velachery la 3 families terrace mela irukanga, thanni yeruthu, food venum urgent. 98xxx xxx10 anna number"
OUT: type=food, severity=high, locality_guess=Velachery, people_count≈3 families,
contact_raw="98xxx xxx10", provenance: location/need/people/contact=stated,
severity=inferred ("rising water + urgent phrasing").

FEW-SHOT 2 (critical floor)
IN: "uncle needs dialysis tomorrow morning, stuck near the old bridge, water till knee"
OUT: type=medical, severity=critical (dialysis keyword floor), locality=unknown→location_text="near the old bridge" ...
```

## Appendix D — Naming note

"Relay" collides with several existing SaaS products; fine for a hackathon, but the Slack app is registered as **"Relay — Crisis Coordination"** and the repo is `relay-crisis` to avoid ambiguity. Revisit branding only if we productize.

---

*End of build doc v1.0 — owners update §16 daily; any change to §2 (hackathon facts) requires re-reading the live rules page first.*

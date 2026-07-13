# Relay — Demo Video: Recording Guide + Voiceover

> **Record the screen SILENT; add the voiceover after.** Hold each key frame **4–6 s**, move the cursor **slowly** in straight lines, grab **2–3 s clean** before/after every click, and record each shot as its **own clip**. Zoom Slack up (Cmd +) so chips/cards stay legible when scaled down. Prefer hard cuts; add a slow push-in (Ken Burns) on static frames. Target **≤ 3:00**; shoot ~5–8 min of raw footage and trim.
>
> **Everything in the DEMO must be the real app in real Slack.** The ▶ Run flood demo counts (real engine, fictional data). The title/stat/close cards below are pre-rendered graphics you drop in during editing — not app footage.

---

## Pre-rendered frames (drop these in during editing)
Local: `docs/…` · also in `public/…` · hosted at `https://relay-crisis-site.vercel.app/<name>.png`

| File | 1920×1080 | Use at |
|---|---|---|
| `frame-1-open.png` | brand open (R. icon + Relay.) | Shot 1 (0:00) |
| `frame-2-hook.png` | "…the deadliest thing is a lost message." | Shot 2 (0:05) |
| `frame-3-stat.png` | counterfactual card (labeled **Simulated**) | Shot 12 (2:15) |
| `frame-4-close.png` | "Every plea heard. Every promise proven." + URL | Shot 14 (2:48) |
| `cap-fictional.png` | transparent overlay · "🧪 all data fictional" | over the flood + any sim data |
| `cap-sla.png` | transparent overlay · "SLA timers compressed for demo" | over the drift beat (Shot 7) |
| `cap-simulated.png` | transparent overlay · "Simulated — both runs measured" | over any stat, if needed |

---

## Prerequisites (mostly done — verify)
- [x] Sandbox app live · bot authenticates · RTS **semantic** live · 4 channels resolved · healthz green
- [x] `#relay-judges` welcome card confirmed
- [ ] **Do Not Disturb** on · hide DMs/other workspaces · one theme (consistent) · 1080p · cursor visible
- [ ] A **delivery photo** on the desktop for the evidence step (supplies/boxes — no real person)
- [ ] A tab open on the **architecture diagram** (`docs/architecture.png` / hosted) for Act 3
- [ ] Dry-run **▶ Run flood demo** once → **↺ Reset**. (Fallback: if a manual step is fiddly, the runner drives the whole hero arc.)

---

## SHOT LIST (frame-level)

### ACT 1 · INTRO (0:00–0:30)
1. **Brand open** *(0:00–0:05)* — `frame-1-open.png`, slow 3 % zoom. **Hold 5 s.**
2. **Hook** *(0:05–0:12)* — `frame-2-hook.png` (or the line typed on black). **Hold 7 s.**
3. **The flood** *(0:12–0:30)* — cut to `#relay-judges` → click **▶ Run flood demo** → switch to `#relay-intake`, raw pleas pour in under **🧪 Relay Simulator**; scroll slowly. Overlay `cap-fictional.png`. **Hold ~15 s.**

### ACT 2 · DEMO — the live app (0:30–2:15)
4. **Live intake** *(0:30–0:42)* — `#relay-intake`: **type slowly** `3 families stuck on a terrace in Velachery, food needed urgently 🙏` → Enter. **Hold 3 s.**
5. **Dispatch card** *(0:42–0:58)* — `#relay-dispatch`: point at **🔴 CRITICAL**, then **stated/inferred/unknown** chips (2 s each), push in. **Hold 16 s.**
6. **Confirm + Assign** *(0:58–1:14)* — **Confirm** (3 s) → **Assign** → top-3 volunteers + score bars (4 s) → pick #1 → **CLAIMED** (3 s).
7. **Drift → reassign** *(1:14–1:36)* — wait ~1 min: **nudge** (opt. cut to the DM, 4 s) → **overdue → reassignment** (click **Reassign** if shown) → **reassigned to vol B** (5 s). Overlay `cap-sla.png`.
8. **Evidence-gated close** *(1:36–1:56)* — **Mark delivered** → modal: **drag photo**, pick **locality**, tick **recipient confirmed** → Submit → **Close** rejected ("insufficient evidence", 3 s) → **Sign off & close** → **Verified ✓ → Closed** (4 s).
9. **Report + audit** *(1:56–2:06)* — `/relay report` → **🔍 Audit** on a number → evidence chain expands (4 s). *(opt. `/relay sitrep` for the ops-map.)*
10. **App Home** *(2:06–2:12)* — sidebar → **Relay → Home** → the operations board, scroll slowly. **Hold 6 s.**
11. **Ask-Relay (live semantic RTS)** *(2:12–2:15+)* — open **Ask Relay** → suggested prompts (2 s) → type `What's the latest on relief in Velachery?` → grounded answer + **cited permalink** (5 s). *(opt: emergency question → refusal.)*

### ACT 3 · HOW IT'S BUILT (2:15–2:52)
12. **Stat card** *(2:15–2:21)* — `frame-3-stat.png` (the counterfactual, **Simulated**). **Hold 6 s.**
13. **Architecture** *(2:21–2:42)* — full-screen the diagram; push-ins: six-verb loop (3 s) → **APPEND-ONLY LEDGER** spine (4 s) → **Slack AI · RTS · MCP** row (4 s).
14. **Close** *(2:42–2:52)* — cut to `#relay-intake` Relay's **bilingual reply in the requester's thread** (5 s) → `frame-4-close.png` (4 s).

---

## VOICEOVER (record calm, present tense; matches the shots above)

> *[open / hook]*
> In a disaster, the deadliest thing is a lost message.
>
> *[the flood]*
> Requests pour in across a dozen threads. The same family gets rescued twice while another is missed. Someone says "I'll go," and quietly drops. Afterward, no one can tell donors what actually happened. Every one of those failures is a state-tracking failure — and Relay fixes it, inside the Slack the volunteers already use.
>
> *[live intake]*
> Any message — any language — becomes a tracked need. Live.
>
> *[dispatch card]*
> Relay structures it, floors the severity on a critical keyword, and separates what was stated from what it only inferred. It never pretends to know what it doesn't.
>
> *[confirm + assign]*
> A human confirms, then assigns — the engine rejects an agent trying to do this alone.
>
> *[drift → reassign]*
> Then the volunteer goes quiet. Relay watches the clock, not the status flag — it nudges, waits, and reroutes to the pre-warmed backup, before the coordinator even noticed.
>
> *[evidence close]*
> And nothing closes on someone's word. Delivery needs a photo, a location, the family's own confirmation, and a coordinator's sign-off. The early close is rejected; only the complete packet verifies.
>
> *[report + audit]*
> Coordinators get a live report where every number links to a ledger event — click any figure and audit the evidence behind it. No names, no guesses.
>
> *[app home]*
> One board holds every open need, and every drifting promise.
>
> *[assistant / RTS]*
> And you can just ask. Relay answers from the ledger and live Slack search, cites its sources, keeps beneficiary contact out of the model — and refuses what it shouldn't.
>
> *[stat card — optional line]*
> Measured against a plain group chat, on the same simulated flood: Relay loses none, double-serves none, and proves delivery where the group chat proves nothing.
>
> *[how it's built]*
> Underneath is an append-only ledger. The AI proposes; deterministic code decides; a human confirms every consequential step. And it uses all three Slack platform capabilities — the assistant, Real-Time Search, and an MCP server that even lets other agents make accountable promises.
>
> *[close]*
> Every plea heard. Every promise proven.

**Number honesty:** the VO speaks no hard stats — the counterfactual card (`frame-3-stat.png`) carries them, labeled **Simulated**. If you voice any number, use only what `npm run eval` / `counterfactual` printed.

---

## Editing checklist
- Assemble shots in order; drop the pre-rendered frames + caption overlays where noted.
- Keep the honesty overlays visible (fictional · SLA compressed · Simulated).
- **≤ 3:00.** Export **1080p**. Upload **Public** to YouTube (not unlisted-with-no-link).
- Paste the YouTube URL into Devpost + tell me so I swap it into the landing page.

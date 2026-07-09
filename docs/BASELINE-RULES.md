# Group-chat baseline — published rules (Moonshot #3, the counterfactual)

> **Honesty note.** This is a **SIMULATION** of unstructured group-chat coordination using the
> rules below, run on the **same fictional scenario** Relay runs (`demo/scenarios/flood-1.yaml`).
> It is **not** a claim about any real deployment, any real group chat, or any real relief
> operation. Every number the comparison prints comes from **actually running** both simulators —
> the naive baseline here, and the real hermetic Relay pipeline — on that one fictional flood.
> Nothing is fabricated, and nothing is tuned to hit a target: the numbers fall out of the
> scenario (how many messages, which are unparseable, which phones repeat) and the seeded roster
> size. The result is labelled **SIMULATED** everywhere it appears.

## Why a baseline at all

Relay's Impact claim is "structured coordination beats an unstructured group chat." That is an
adjective until it is a measured number. This baseline is the smallest honest way to produce that
number: encode how a naive group chat would handle the identical flood, run it, and print the
delta versus what Relay actually did on the same scenario. Because the rules are naive **and
published**, a skeptic can check that the baseline was not rigged to lose.

## The naive rules

The baseline treats the scenario's intake messages as a stream of "requests" posted into one busy
channel, and coordinates them with four deterministic rules. Each rule is tagged (`R1`…`R4`) and
referenced by tag in `src/demo/baseline.ts`.

### R1 — No dedupe → double-served

Every intake message is a **separate request**. A group chat has no mechanism to notice that two
posts describe the same incident, so both get a volunteer. A request whose **normalized beneficiary
phone equals an earlier request's phone** is the same incident served twice — a `double_served`.

- The phone is normalized with the same `normalizeContact` the pipeline uses (Indian-mobile aware),
  so two posts of `98400 01123` collide regardless of spacing.
- Exact-contact collision is the **only** duplicate signal derivable from raw scenario data without
  a fuzzy text matcher. Reworded, no-contact repeats (which a real chat also cannot catch) are
  **not** counted here — so the double-serve figure is, if anything, an **under-count**. This is
  deliberate: the baseline is conservative, never inflated.

### R2 — No triage → ambiguity drop (unclaimed)

A message a naive reader cannot turn into an **actionable** need — no type, no place, no head-count —
gets no claimant, because nobody knows what to do with it. "Actionable" is decided by the
deterministic `HeuristicExtractor` (a plain keyword skim, the pipeline's zero-env parse): if it
returns `needs_review`, the request is **unparseable** and goes unclaimed.

This models the naive reader only. It is **not** Relay's LLM extraction, severity floor, or human
NEEDS_REVIEW card — those are exactly the structure the baseline is meant to lack. (Relay routes the
same message to a human review card and keeps it on the board; the group chat just scrolls past it.)

### R3 — First-claim-wins, no tracking, finite attention → capacity overflow (unclaimed)

Volunteers claim actionable requests in **arrival order** (first-claim-wins). With no assignment
board reminding anyone of open work — and with nothing ever verified-closed (R4), so a claim never
frees its owner — each responder can shepherd only **one** request. Once the responder pool is
exhausted, every later request **scrolls past unclaimed**.

- The responder pool is the **seeded volunteer roster** (`loadSeedVolunteers`, `seed/volunteers.json`) —
  the **same people Relay coordinates**. Using the shared roster (not a hand-picked constant) keeps
  the comparison symmetric and un-rigged. A test may pin the pool explicitly.
- A duplicate request (R1) that gets claimed still burns a responder on redundant work — capacity
  the chat cannot get back. A duplicate that scrolls past instead is counted as `unclaimed`, not
  `double_served`.

`unclaimed` = R2 ambiguity drops + R3 capacity overflow.

### R4 — No verification → 0 verified

"Delivered" is self-reported ("got it 👍") and unproven. A group chat produces no evidence packet,
no recipient confirmation, and no coordinator sign-off, so `verified_deliveries` is **always 0**.

## What the simulator returns

`runGroupChatBaseline(scenario)` returns a `BaselineOutcome`:

| field                 | meaning                                                                  |
| --------------------- | ------------------------------------------------------------------------ |
| `total_requests`      | one per intake message (R1, no dedupe)                                    |
| `responder_pool`      | responders available (R3 — the seeded roster, unless pinned)             |
| `unparseable`         | requests a naive reader could not act on (R2)                            |
| `claimed`             | requests a responder committed to (served + double-served)               |
| `distinct_served`     | claimed requests that covered a distinct incident once                   |
| `double_served`       | claimed requests that duplicated an earlier contact (R1)                 |
| `unclaimed`           | requests that never got a claimant (R2 + R3)                             |
| `verified_deliveries` | always `0` (R4)                                                          |
| `trace`               | per-request disposition in arrival order (fully auditable)               |

## The counterfactual comparison

`runCounterfactual(scenarioName)` (in `src/demo/counterfactual.ts`) runs this baseline **and** drives
the identical scenario through the **real hermetic Relay pipeline** (the same driver assembly
`npm run demo` uses), to verification where the scenario supports it. Every Relay number —
needs tracked, exact-contact auto-links, fuzzy merge proposals, human-review routes, verified
deliveries — is **measured from the actual ledger**, never fabricated. The delta is a function of
those two measured sets.

Run it: `npm run counterfactual` (prints the clearly-SIMULATED comparison and the one-line
headline). The rules above are the contract; the numbers are whatever the run produces.

## Illustrative result on `flood-1`

Produced by **running** the simulators on the frozen scenario (not hand-written; re-run to verify):

- **Group-chat baseline (SIMULATED):** 14 requests, 12 responders → **2 unclaimed** (1 unparseable
  garbled distress call + 1 past capacity), **2 double-served** (the two duplicate reports of the
  dialysis patient and the trapped family), **0 verified**.
- **Relay (MEASURED):** 14 needs tracked (0 lost), 1 routed to human review, **2 duplicates
  auto-linked**, 1 proposed for human merge, **1 verified** delivery on a complete evidence packet.
- **Delta:** 2 double-serves avoided, 2 requests kept owned instead of lost, +1 verified delivery
  over the baseline's zero.

import type { Scenario } from '../../demo/scenarios/schema';
import { computeSlaDueAtMs } from '../drift/sla';
import type { Command } from '../ledger/events';
import { needEventKey } from '../ledger/idempotency';
import type { DispatchResult, NeedService } from '../ledger/needService';
import { DEFAULT_RISK_WINDOW_MS } from '../ledger/projection';
import { meetsVerificationPolicy } from '../ledger/stateMachine';
import type { Actor, ProjectedNeed } from '../ledger/types';
import { logger } from '../lib/logger';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import type { VolunteerStore } from '../match/volunteerStore';

// The LIVE self-serve hero orchestrator (BUILD-DOC §F5, CLAUDE.md cut-line "never
// cut: the drift-reassign hero moment"). Today the live "Run flood demo" button only
// posts the 14 intake messages (src/demo/injector.ts); the claim→drift→release→
// reassign→deliver→evidence→sign-off→close signature sequence exists ONLY inside the
// hermetic driver (src/demo/driver.ts, against a RecordingNotifier). So a judge who
// presses the button never watches the hero moment happen live.
//
// This module drives that FULL sequence against the REAL pipeline + ledger, as
// INJECTED side effects (postIntake / narrate / driftSweep / pickTarget / sleep), so
// it is hermetically testable AND wires into the live app unchanged. It is the live
// analog of the driver's `hero_e2e`: it reuses the exact same ledger seams (NeedService.
// dispatch, computeSlaDueAtMs, runDriftSweep behind driftSweep, topN, meetsVerification-
// Policy, needEventKey) so the live board reaches CLOSED through the same engine the
// tests prove. Every consequential transition carries a LABELED human actor (demoActor)
// — the whole run is a declared simulation (🧪), and the human gates are honoured, not
// bypassed. It never surfaces beneficiary PII (only public ids, severity, type, and the
// workspace-public volunteer display name).
//
// Design contract: each beat = a short narrate() line, then the ledger action, then a
// sleep for on-camera pacing. It DEGRADES GRACEFULLY — if a beat has no target to drive
// it narrates a "skipped" line and continues; it never throws (an unexpected error is
// logged and the beat is recorded as skipped). The returned `beats` list is the ordered
// trace of what fired, for the caller/tests to assert.

/** Which simulator channel a narration line is posted into. */
export type NarrateChannel = 'dispatch' | 'hq' | 'volunteers';

/** Stable beat identifiers (returned in order). Skip variants are pushed when a beat has
 * no target to drive, so the caller can distinguish a full run from a degraded one. */
export const HERO_BEATS = {
  intake: 'intake:flood-posted',
  triage: 'triage:confirmed',
  triageSkipped: 'triage:skipped',
  assign: 'match:assigned',
  assignSkipped: 'match:skipped',
  nudge: 'drift:nudged',
  nudgeSkipped: 'drift:skipped',
  reassign: 'reassign:handoff',
  reassignSkipped: 'reassign:skipped',
  deliver: 'evidence:closed',
  deliverSkipped: 'evidence:skipped',
  sitrep: 'sitrep:pointer',
} as const;

/** Pause after the flood so the real (async) pipeline can triage the 14 into #relay-dispatch
 * before we pick a target. Generous by default; the integrator can inject a longer sleep. */
export const INTAKE_SETTLE_MS = 6000;
/** Between-beat pause so judges watch the sequence unfold. No-op under a virtual sleep. */
export const BEAT_PAUSE_MS = 1800;

export interface LiveHeroDemoDeps {
  /** The frozen scenario (flood-1). Threaded to `postIntake` and read for `sla_multiplier`. */
  scenario: Scenario;
  service: NeedService;
  volunteerStore: VolunteerStore;
  /** Gazetteer coords for the deterministic scorer (loadLocalityCoords()). Injected so the
   * orchestrator stays hermetic. */
  localities: LocalityCoord[];
  /** Post the 14 intake messages as the 🧪 simulator into #relay-intake (reuse runFloodInjector). */
  postIntake: (opts: { scenario: Scenario }) => Promise<void>;
  /** Run one drift sweep at the given clock (triggers runDriftSweep behind the wired callbacks). */
  driftSweep: (now: number) => Promise<void>;
  /** Post a 🧪 narration line so judges follow the beats. */
  narrate: (channel: NarrateChannel, text: string) => Promise<void>;
  /** Query listNeeds for a need to drive (returns the first match, or null). */
  pickTarget: (predicate: (need: ProjectedNeed) => boolean) => Promise<ProjectedNeed | null>;
  /** Resolve a need's public id (N-000x) for judge-facing narration (falls back to the raw id). */
  resolvePublicId: (needId: string) => Promise<string>;
  /** Clock seed (real Date.now live; a virtual base in tests). */
  now: () => number;
  /** Visual pacing (real setTimeout live; a no-op/virtual in tests). */
  sleep: (ms: number) => Promise<void>;
  /** A LABELED human actor — the sequence is a declared simulation and gated events need a human. */
  demoActor: Actor;
}

export interface LiveHeroDemoResult {
  beats: string[];
}

/** Evidence attaches are stamped by an agent that references the delivering party — never a
 * human gate. The recipient closes their own loop (§F5); the coordinator sign-off is the gate. */
const RECIPIENT_ACTOR: Actor = { type: 'agent', id: 'DEMO_RECIPIENT' };
const EVIDENCE_ACTOR: Actor = { type: 'agent', id: 'relay-evidence' };
const MATCH_ACTOR: Actor = { type: 'system', id: 'relay-match' };

/** A pre-open need worth confirming, preferring the highest-stakes report. */
const isCriticalTriaged = (n: ProjectedNeed): boolean =>
  (n.state === 'TRIAGED' || n.state === 'NEEDS_REVIEW') && (n.severity === 'critical' || n.severity === 'high');
const isTriaged = (n: ProjectedNeed): boolean => n.state === 'TRIAGED' || n.state === 'NEEDS_REVIEW';

/**
 * Drive the full hero sequence against the live pipeline + ledger. Returns the ordered beat
 * trace. Self-contained: does NOT touch the Slack app or server — the integrator wires
 * judge_run_demo → runLiveHeroDemo with live side effects (see the note at the bottom of this file).
 */
export async function runLiveHeroDemo(deps: LiveHeroDemoDeps): Promise<LiveHeroDemoResult> {
  const beats: string[] = [];

  // A monotonic LOGICAL clock, seeded from now(). Ledger `at`/`now` come from here so event
  // timestamps stay ordered even when we jump the clock forward to fire drift "on cue"
  // (the live analog of the driver's InMemoryScheduler virtual clock). `sleep` is decoupled:
  // it only paces the visuals for humans and does not need to match the logical clock.
  let clockMs = deps.now();
  const advance = (ms = 1000): number => {
    clockMs += ms;
    return clockMs;
  };
  const jumpTo = (ms: number): void => {
    if (ms > clockMs) clockMs = ms;
  };
  const iso = (ms: number): string => new Date(ms).toISOString();

  const emit = async (
    needId: string,
    command: Command,
    discriminator: string,
    actor: Actor,
  ): Promise<DispatchResult> => {
    const ms = advance();
    return deps.service.dispatch(needId, command, {
      actor,
      at: iso(ms),
      idempotencyKey: needEventKey(needId, command.type, discriminator),
      now: ms,
    });
  };

  const publicIdOf = async (needId: string): Promise<string> => {
    try {
      return await deps.resolvePublicId(needId);
    } catch {
      return needId;
    }
  };
  const volunteerName = async (slackUserId: string): Promise<string> => {
    try {
      return (await deps.volunteerStore.getBySlackUser(slackUserId))?.display_name ?? slackUserId;
    } catch {
      return slackUserId;
    }
  };

  // Threaded across beats: the single need we drive from triage all the way to CLOSED.
  let targetId: string | null = null;
  let firstVolId: string | null = null;
  let secondVolId: string | null = null;

  // --- Beat 1: post the flood, let the real pipeline triage it -----------------
  try {
    await deps.narrate(
      'dispatch',
      'Simulating the flood — 14 reports are hitting #relay-intake. The live pipeline is triaging them into #relay-dispatch now.',
    );
    await deps.postIntake({ scenario: deps.scenario });
    await deps.sleep(INTAKE_SETTLE_MS);
    beats.push(HERO_BEATS.intake);
  } catch (err) {
    logger.error({ err }, 'live hero: intake beat failed');
    beats.push(HERO_BEATS.intake);
  }

  // --- Beat 2: confirm a critical need out of triage (human gate) --------------
  try {
    const picked = (await deps.pickTarget(isCriticalTriaged)) ?? (await deps.pickTarget(isTriaged));
    if (picked === null) {
      await deps.narrate('dispatch', 'No triaged need to drive yet — skipping the hero sequence.');
      beats.push(HERO_BEATS.triageSkipped);
    } else {
      targetId = picked.need_id;
      const publicId = await publicIdOf(targetId);
      await deps.narrate(
        'dispatch',
        `Coordinator confirms ${publicId} — a ${picked.severity} ${picked.type} need. Moving it out of triage to open.`,
      );
      const res = await emit(targetId, { type: 'TriageConfirmed', payload: {} }, 'live-hero', deps.demoActor);
      // Already OPEN (suppressed/illegal) is fine — the drive continues from the current state.
      if (res.status === 'rejected') logger.warn({ code: res.code }, 'live hero: TriageConfirmed not applied');
      await deps.sleep(BEAT_PAUSE_MS);
      beats.push(HERO_BEATS.triage);
    }
  } catch (err) {
    logger.error({ err }, 'live hero: triage beat failed');
    beats.push(HERO_BEATS.triageSkipped);
  }

  // --- Beat 3: match + assign to the top volunteer (human-gated Assigned) -------
  try {
    const need = targetId === null ? null : await deps.service.getNeed(targetId, clockMs);
    if (targetId === null || need === null) {
      await deps.narrate('dispatch', 'Assignment skipped: no target need.');
      beats.push(HERO_BEATS.assignSkipped);
    } else {
      const scoreNeed: ScoreNeed = { type: need.type, localityId: need.locality_id, languages: need.languages };
      const top = topN(scoreNeed, await deps.volunteerStore.list(), deps.localities, 3);
      const winner = top[0]?.volunteer ?? null;
      if (winner === null) {
        await deps.narrate('dispatch', 'Assignment skipped: no volunteers on the roster.');
        beats.push(HERO_BEATS.assignSkipped);
      } else {
        firstVolId = winner.slack_user_id;
        const publicId = await publicIdOf(targetId);
        const name = await volunteerName(firstVolId);
        await deps.narrate(
          'dispatch',
          `Assigning ${publicId} to ${name} — top match on skills, proximity and spare capacity.`,
        );
        await emit(
          targetId,
          {
            type: 'MatchSuggested',
            payload: {
              candidates: top.map((c) => ({
                volunteer_id: c.volunteer.slack_user_id,
                score: Math.round(c.score * 10000) / 10000,
              })),
            },
          },
          'live-assign',
          MATCH_ACTOR,
        );
        const assignMs = advance();
        const slaDueAt = iso(computeSlaDueAtMs(need.type, need.severity, assignMs, deps.scenario.sla_multiplier));
        const assigned = await deps.service.dispatch(
          targetId,
          {
            type: 'Assigned',
            payload: { volunteer_id: firstVolId, obligation_id: `OB-${assignMs}`, sla_due_at: slaDueAt },
          },
          {
            actor: deps.demoActor,
            at: iso(assignMs),
            idempotencyKey: needEventKey(targetId, 'Assigned', 'live-assign'),
            now: assignMs,
          },
        );
        if (assigned.status === 'applied') await deps.volunteerStore.incrementLoad(firstVolId, 1);
        await deps.sleep(BEAT_PAUSE_MS);
        beats.push(HERO_BEATS.assign);
      }
    }
  } catch (err) {
    logger.error({ err }, 'live hero: assign beat failed');
    beats.push(HERO_BEATS.assignSkipped);
  }

  // --- Beat 4: advance the clock into the (compressed) SLA window → drift nudge --
  try {
    const need = targetId === null ? null : await deps.service.getNeed(targetId, clockMs);
    const dueMs = need?.sla_due_at ? Date.parse(need.sla_due_at) : Number.NaN;
    if (targetId === null || need === null || Number.isNaN(dueMs)) {
      await deps.narrate('volunteers', 'Drift check skipped: nothing is claimed yet.');
      beats.push(HERO_BEATS.nudgeSkipped);
    } else {
      const publicId = await publicIdOf(targetId);
      const name = firstVolId === null ? 'the volunteer' : await volunteerName(firstVolId);
      await deps.narrate('volunteers', `SLA on ${publicId} is drifting — nudging ${name} for an update.`);
      // A sweep strictly inside the risk window, before due → Nudged('at_risk') + DM (mirrors the
      // driver's preDue: within [due - riskWindow, due], and after assign + budget/2).
      const budget = dueMs - clockMs;
      const preDue = Math.max(1, Math.min(Math.floor(budget / 2), DEFAULT_RISK_WINDOW_MS - 1));
      const sweepNow = dueMs - preDue;
      await deps.driftSweep(sweepNow);
      jumpTo(sweepNow);
      await deps.sleep(BEAT_PAUSE_MS);
      beats.push(HERO_BEATS.nudge);
    }
  } catch (err) {
    logger.error({ err }, 'live hero: drift beat failed');
    beats.push(HERO_BEATS.nudgeSkipped);
  }

  // --- Beat 5: the HERO MOMENT — release → re-route to a second volunteer -------
  try {
    const need = targetId === null ? null : await deps.service.getNeed(targetId, clockMs);
    if (targetId === null || need === null || firstVolId === null) {
      await deps.narrate('dispatch', 'Reassignment skipped: no claimed target.');
      beats.push(HERO_BEATS.reassignSkipped);
    } else {
      // The first volunteer gets stuck and hands the obligation back → OPEN.
      const released = await emit(
        targetId,
        { type: 'ClaimReleased', payload: { volunteer_id: firstVolId, reason: 'volunteer_released' } },
        'live-release',
        { type: 'human', id: firstVolId },
      );
      if (released.status === 'applied') await deps.volunteerStore.incrementLoad(firstVolId, -1);

      // Re-score the fresh top-3 EXCLUDING the first volunteer, then hand the obligation over.
      // From OPEN the legal commit transition is Assigned (Reassigned applies only from a still-held
      // CLAIMED/IN_PROGRESS need); the live need_reassign_pick handler is state-aware and picks
      // whichever the current state allows. See driver.ts evaluateDrift for the same reasoning.
      const scoreNeed: ScoreNeed = { type: need.type, localityId: need.locality_id, languages: need.languages };
      const remaining = (await deps.volunteerStore.list()).filter((v) => v.slack_user_id !== firstVolId);
      const winner = topN(scoreNeed, remaining, deps.localities, 3)[0]?.volunteer ?? null;
      if (winner === null) {
        await deps.narrate('dispatch', 'Reassignment skipped: no second volunteer available.');
        beats.push(HERO_BEATS.reassignSkipped);
      } else {
        secondVolId = winner.slack_user_id;
        const publicId = await publicIdOf(targetId);
        const secondName = await volunteerName(secondVolId);
        await deps.narrate(
          'dispatch',
          `The first volunteer got stuck; Relay caught the drift and re-routed ${publicId} to ${secondName} before anything was missed.`,
        );
        await emit(
          targetId,
          {
            type: 'MatchSuggested',
            payload: { candidates: [{ volunteer_id: secondVolId, score: 1 }] },
          },
          'live-reassign',
          MATCH_ACTOR,
        );
        const reassignMs = advance();
        const open = (await deps.service.getNeed(targetId, reassignMs)) ?? need;
        const slaDueAt = iso(computeSlaDueAtMs(open.type, open.severity, reassignMs, deps.scenario.sla_multiplier));
        const reassigned = await deps.service.dispatch(
          targetId,
          {
            type: 'Assigned',
            payload: { volunteer_id: secondVolId, obligation_id: `OB-${reassignMs}`, sla_due_at: slaDueAt },
          },
          {
            actor: deps.demoActor,
            at: iso(reassignMs),
            idempotencyKey: needEventKey(targetId, 'Assigned', 'live-reassign'),
            now: reassignMs,
          },
        );
        if (reassigned.status === 'applied') await deps.volunteerStore.incrementLoad(secondVolId, 1);
        await deps.sleep(BEAT_PAUSE_MS);
        beats.push(HERO_BEATS.reassign);
      }
    }
  } catch (err) {
    logger.error({ err }, 'live hero: reassign beat failed');
    beats.push(HERO_BEATS.reassignSkipped);
  }

  // --- Beat 6: the second volunteer delivers → evidence packet → Verified → Closed
  try {
    const held = targetId === null ? null : await deps.service.getNeed(targetId, clockMs);
    const holder = held?.assigned_volunteer_id ?? secondVolId;
    if (
      targetId === null ||
      held === null ||
      holder === null ||
      (held.state !== 'CLAIMED' && held.state !== 'IN_PROGRESS')
    ) {
      await deps.narrate('dispatch', 'Delivery skipped: no claimed obligation to prove.');
      beats.push(HERO_BEATS.deliverSkipped);
    } else {
      const holderActor: Actor = { type: 'agent', id: holder };
      // Evidence stores REFERENCES only (a Slack file id) — never beneficiary content (zero-copy, #5).
      await emit(
        targetId,
        {
          type: 'EvidenceAttached',
          payload: { kind: 'photo', evidence_id: 'F_DEMO_PHOTO', meta: { via: 'live-demo' } },
        },
        'live-photo',
        holderActor,
      );
      await emit(
        targetId,
        { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', meta: { via: 'live-demo' } } },
        'live-locality',
        holderActor,
      );
      await emit(
        targetId,
        { type: 'RecipientConfirmed', payload: { confirmed_by: 'recipient' } },
        'live-recipient',
        RECIPIENT_ACTOR,
      );
      await emit(
        targetId,
        { type: 'EvidenceAttached', payload: { kind: 'recipient_confirm', meta: { via: 'live-demo' } } },
        'live-recipient',
        RECIPIENT_ACTOR,
      );
      await emit(
        targetId,
        { type: 'EvidenceAttached', payload: { kind: 'coordinator_signoff', meta: { via: 'live-demo' } } },
        'live-signoff',
        EVIDENCE_ACTOR,
      );
      await emit(targetId, { type: 'CoordinatorSignedOff', payload: {} }, 'live-signoff', deps.demoActor);

      const publicId = await publicIdOf(targetId);
      const preVerify = await deps.service.getNeed(targetId, clockMs);
      if (preVerify !== null && meetsVerificationPolicy(preVerify)) {
        await emit(targetId, { type: 'Verified', payload: {} }, 'live-final', deps.demoActor);
        await emit(targetId, { type: 'Closed', payload: {} }, 'live-final', deps.demoActor);
        await deps.narrate(
          'dispatch',
          `Delivery proven for ${publicId}: photo + location + recipient confirmation → signed off & closed.`,
        );
        await deps.sleep(BEAT_PAUSE_MS);
        beats.push(HERO_BEATS.deliver);
      } else {
        await deps.narrate('dispatch', `Delivery skipped: ${publicId} evidence packet is incomplete.`);
        beats.push(HERO_BEATS.deliverSkipped);
      }
    }
  } catch (err) {
    logger.error({ err }, 'live hero: delivery beat failed');
    beats.push(HERO_BEATS.deliverSkipped);
  }

  // --- Beat 7: point judges at the live verified picture -----------------------
  try {
    await deps.narrate('hq', 'Run /relay sitrep for the live verified picture.');
    beats.push(HERO_BEATS.sitrep);
  } catch (err) {
    logger.error({ err }, 'live hero: sitrep pointer failed');
    beats.push(HERO_BEATS.sitrep);
  }

  return { beats };
}

// --- Integrator note ---------------------------------------------------------
// Wire judge_run_demo → runLiveHeroDemo with LIVE side effects, fire-and-forget AFTER ack
// (Ack < 3s, work async — invariant #6):
//   · postIntake  → runFloodInjector (chat.postMessage username = 🧪 persona, into #relay-intake).
//   · narrate     → chat.postMessage into #relay-dispatch / #relay-hq / the volunteers channel
//                   under the "Relay Simulator 🧪" username (SIMULATOR_IDENTITY), so every line
//                   is a declared simulation.
//   · driftSweep  → runDriftSweep({ service, listNeeds, notifyNudge, proposeReassign, now })
//                   over buildDriftCallbacks(...) — the SAME callbacks live mode already wires.
//   · pickTarget  → (pred) => (await service.listNeeds(now())).find(pred) ?? null.
//   · resolvePublicId → store.getPublicId (fallback to the raw id).
//   · now/sleep   → Date.now / setTimeout (the constants above pace the reveal on camera).
//   · demoActor   → a LABELED human coordinator, e.g. { type: 'human', id: 'DEMO_COORDINATOR' }.
// Also add a real wall-clock drift tick in live mode (a repeatable sweep on the Scheduler seam)
// so obligations that are NOT part of this scripted run still drift on their own SLA; this
// orchestrator only fires the ONE scripted on-cue nudge for the driven target.

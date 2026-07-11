import { randomUUID } from 'node:crypto';
import { App, Assistant } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { Scenario } from '../../demo/scenarios/schema';
import { askRelay } from '../assistant/askRelay';
import { RtsClient, type RtsResolver } from '../assistant/rts';
import { createMockRts } from '../assistant/rtsMock';
import {
  DEGRADED_BANNER,
  describe as degradeBanner,
  getDegrade,
  narrationLlmFor,
  setDegrade,
} from '../demo/degradeMode';
import { compressedClockNote, type InjectorPostMessage, runFloodInjector, SIMULATOR_IDENTITY } from '../demo/injector';
import { type LiveHeroDemoDeps, type NarrateChannel, runLiveHeroDemo } from '../demo/liveOrchestrator';
import { type DemoResetStore, type ResetDemoResult, resetDemo } from '../demo/reset';
import { type BackupCandidate, computeBackup } from '../drift/prewarm';
import { slaDueAtIso } from '../drift/sla';
import { needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { EventStore } from '../ledger/store/eventStore';
import type { ConfidenceStatus, ProjectedNeed } from '../ledger/types';
import type { AuditLog } from '../lib/auditLog';
import { checkHealth, type HealthDeps } from '../lib/health';
import { logger } from '../lib/logger';
import type { ContactVault } from '../lib/vault';
import type { LlmProvider } from '../llm/provider';
import { matchRationale } from '../match/rationale';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import type { Volunteer, VolunteerStore } from '../match/volunteerStore';
import { generateReport, parseReportPeriod } from '../narrate/report';
import { generateSitrep } from '../narrate/sitrep';
import type { PipelineQueue } from '../pipeline/queue';
import type { HomeViewOptions } from '../surfaces/appHome';
import { buildAssistantAnswer } from '../surfaces/assistantAnswer';
import { buildAuditTrail, buildReportAuditPanel, decodeFigureAudit, REPORT_AUDIT_ACTION } from '../surfaces/auditTrail';
import { buildCanvasDocument, type CanvasWriteClient, writeCanvas } from '../surfaces/canvas';
import { buildNudgeBlocks, DELAYED_ACTION, ENROUTE_ACTION, type NudgeAck, RELEASE_ACTION } from '../surfaces/driftCard';
import { buildEditModal, EDIT_CALLBACK_ID, parseEditSubmission } from '../surfaces/editModal';
import {
  buildDeliveryModal,
  buildRecipientConfirmPrompt,
  DELIVERY_CALLBACK_ID,
  MARK_DELIVERED_ACTION,
  parseDeliverySubmission,
  RECIPIENT_CONFIRM_ACTION,
  RECIPIENT_SUBSTITUTE_ACTION,
  SIGNOFF_ACTION,
} from '../surfaces/evidenceModal';
import { decodeHomeFilter, type HomeFilter } from '../surfaces/homeFilters';
import {
  buildArchitecture,
  buildGuidedTour,
  buildJudgeWelcome,
  JUDGE_ARCH,
  JUDGE_RESET,
  JUDGE_RUN_DEMO,
  JUDGE_TOUR,
} from '../surfaces/judgeChannel';
import {
  ASSIGN_PICK_ACTION,
  buildMatchBlocks,
  type MatchNeed,
  parseAssignTarget,
  type RankedCandidate,
  REASSIGN_PICK_ACTION,
} from '../surfaces/matchCard';
import { NEED_EDIT_ACTION, NEED_ESCALATE_ACTION, parseMergeTarget } from '../surfaces/needCard';
import { buildOpsMapSvg } from '../surfaces/opsMap';
import {
  ACTIONS,
  context,
  divider,
  escapeMrkdwn,
  fields,
  parseActionId,
  type SlackBlock,
  type SlackView,
  section,
} from '../surfaces/primitives';
import type { RequesterReplyKind } from '../surfaces/requesterReplies';
import { canSignOff, EVIDENCE_KIND_LABEL } from '../surfaces/verification';
import { buildVolunteerModal, parseVolunteerSubmission, VOLUNTEER_CALLBACK_ID } from '../surfaces/volunteerModal';
import type { DedupeStore } from './dedupe';
import { handleIntakeMessage } from './intakeHandler';
import type { CardRef, Notifier } from './notifier';
import { postRequesterReply } from './requesterReply';

// The Bolt transport (ported from kept's slackApp.ts, dual-mode). It maps Slack
// events/actions onto the intake pipeline; all real logic (dedupe, ledger gates,
// zero-copy) lives in the modules. Socket Mode iff an app token is present; a
// GET /healthz custom route works in BOTH modes so Docker / the ALB / UptimeRobot
// always have a target.

/** Channel ids resolved at boot and shared with the notifier (dispatch) + message
 * gate (intake). Mutated in place by start(), so holders wired before resolution
 * see the resolved ids. */
export interface MutableRoles {
  intakeChannelId: string;
  dispatchChannelId: string;
  /** #relay-hq — where sitreps/reports post. Falls back to dispatch when unresolved. */
  hqChannelId: string;
  /** #judges-start-here — the judge on-ramp (F8). Falls back to dispatch when unresolved. */
  judgesChannelId: string;
}

export interface ChannelRoleConfig {
  /** RELAY_INTAKE_CHANNEL override (a channel id). */
  intakeChannelId?: string;
  /** RELAY_DISPATCH_CHANNEL override (a channel id). */
  dispatchChannelId?: string;
  /** RELAY_HQ_CHANNEL override (a channel id). */
  hqChannelId?: string;
  /** RELAY_JUDGES_CHANNEL override (a channel id). */
  judgesChannelId?: string;
  /** Fallback name lookup via conversations.list. */
  intakeChannelName?: string;
  dispatchChannelName?: string;
  hqChannelName?: string;
  judgesChannelName?: string;
}

export interface SlackAppDeps {
  botToken: string;
  signingSecret: string;
  appToken?: string;
  port: number;
  service: NeedService;
  queue: PipelineQueue;
  dedupe: DedupeStore;
  notifier: Notifier;
  roles: MutableRoles;
  channelConfig?: ChannelRoleConfig;
  /** The registry the matcher scores against (in-memory in dev, Postgres in prod). */
  volunteerStore: VolunteerStore;
  /** Gazetteer coordinates for the proximity term of the scorer. */
  localities: LocalityCoord[];
  /** The event store — used to resolve a need's public_id for card labels. */
  store?: EventStore;
  /** Encrypted contact vault (reveal path). Undefined = vaulting disabled. */
  vault?: ContactVault;
  /** Append-only audit trail; a contact reveal writes one row. */
  auditLog?: AuditLog;
  /** Optional LLM for the one-line match rationale (falls back to a template). */
  llm?: LlmProvider;
  /** Tag volunteer onboarding rows as demo data. */
  isDemo?: boolean;
  /** SLA compression multiplier (config.slaMultiplier); stamped onto Assigned/Reassigned. */
  slaMultiplier?: number;
  /** Post a reassignment card (fresh top-3) to #relay-dispatch. Wired in src/server.ts from
   * buildDriftCallbacks so the button handlers and the drift sweep share one implementation.
   * Undefined disables the auto-reassign side effects (e.g. drift-less tests). */
  proposeReassign?: (need: ProjectedNeed, excludeVolunteerId?: string) => Promise<void>;
  /** Run ONE drift sweep over the real service at the given clock (server wires the SAME closure
   * the scheduler ticks: runDriftSweep with notifyNudge + proposeReassign). The live hero demo
   * fires this on cue; undefined disables the scripted drift beat (it degrades to skipped). */
  driftSweep?: (now: number) => Promise<void>;
  /** The flood scenario the judge "Run demo" button + `/relay demo start` play into #relay-intake
   * (as the 🧪 simulator). Undefined disables the judge demo (the button reports it's unconfigured). */
  demoScenario?: Scenario;
  /** The demo teardown seam behind the judge "Reset" button + `/relay demo reset`. Postgres purge
   * in prod, an in-memory stand-in offline. Undefined ⇒ reset only republishes App Home. */
  demoResetStore?: DemoResetStore;
  /** User token (xoxp-) enabling live Real-Time Search grounding for the Assistant; when absent
   * the assistant uses the deterministic RTS mock and answers ledger-only (CLAUDE.md §9 honesty). */
  slackUserToken?: string;
  /** Deep-health inputs for GET /healthz: the live pg.Pool + a Redis PING seam. A missing dep
   * reports 'skip' (a valid in-memory config); a present-but-failing dep flips ok:false → 503 so
   * UptimeRobot / the ALB pull the task from rotation. Undefined ⇒ the route reports skip/skip. */
  health?: HealthDeps;
}

const DEFAULT_INTAKE_NAME = 'relay-intake';
const DEFAULT_DISPATCH_NAME = 'relay-dispatch';
const DEFAULT_HQ_NAME = 'relay-hq';
const DEFAULT_JUDGES_NAME = 'judges-start-here';

/** Build a name→id map of every channel the bot can see (paginated). */
async function channelsByName(client: WebClient): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const res = await client.conversations.list({
      exclude_archived: true,
      limit: 1000,
      types: 'public_channel,private_channel',
      cursor,
    });
    for (const ch of res.channels ?? []) {
      if (ch.name && ch.id) map.set(ch.name, ch.id);
    }
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return map;
}

/** Resolve intake/dispatch/hq channel ids (env override first, then name lookup). HQ falls
 * back to dispatch when it can't be resolved (so sitreps still land somewhere). */
async function resolveRoles(client: WebClient, roles: MutableRoles, cfg: ChannelRoleConfig): Promise<void> {
  const intakeId = cfg.intakeChannelId;
  const dispatchId = cfg.dispatchChannelId;
  const hqId = cfg.hqChannelId;
  const judgesId = cfg.judgesChannelId;
  const needsLookup = !intakeId || !dispatchId || !hqId || !judgesId;
  // Best-effort: a bad/placeholder token, a transient Slack error, or channels not
  // created yet must NOT crash-loop boot. Resolve what we can and start regardless —
  // /healthz then comes up, and roles fill in from env overrides or a later restart.
  let byName = new Map<string, string>();
  if (needsLookup) {
    try {
      byName = await channelsByName(client);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'resolveRoles: channel lookup failed — starting with unresolved roles (set RELAY_*_CHANNEL or fix the token)',
      );
    }
  }
  roles.intakeChannelId = intakeId ?? byName.get(cfg.intakeChannelName ?? DEFAULT_INTAKE_NAME) ?? '';
  roles.dispatchChannelId = dispatchId ?? byName.get(cfg.dispatchChannelName ?? DEFAULT_DISPATCH_NAME) ?? '';
  roles.hqChannelId = hqId ?? byName.get(cfg.hqChannelName ?? DEFAULT_HQ_NAME) ?? roles.dispatchChannelId;
  // #judges-start-here is optional; when it can't be resolved the judge welcome simply isn't
  // published, but the four judge actions + `/relay demo …` still work from any channel.
  roles.judgesChannelId =
    judgesId ?? byName.get(cfg.judgesChannelName ?? DEFAULT_JUDGES_NAME) ?? roles.dispatchChannelId;
}

/** Safely read an action_id off Bolt's (union-typed) action payload. */
function readActionId(action: unknown): string {
  if (typeof action === 'object' && action !== null && 'action_id' in action) {
    const id = (action as { action_id: unknown }).action_id;
    return typeof id === 'string' ? id : '';
  }
  return '';
}

/** Safely read a button's `value` off Bolt's (union-typed) action payload. */
function readActionValue(action: unknown): string {
  if (typeof action === 'object' && action !== null && 'value' in action) {
    const v = (action as { value: unknown }).value;
    return typeof v === 'string' ? v : '';
  }
  return '';
}

/** Safely read channel + user ids off Bolt's (union-typed) block-action body. */
function readBodyContext(body: unknown): { channel?: string; user?: string } {
  const b = body as { user?: { id?: string }; channel?: { id?: string } };
  return { channel: b?.channel?.id, user: b?.user?.id };
}

/** The clicked card's message coordinates (channel + ts) for chat.update, or null. */
function readCardRef(body: unknown): { channel: string; ts: string } | null {
  const b = body as { channel?: { id?: string }; container?: { message_ts?: string }; message?: { ts?: string } };
  const channel = b?.channel?.id;
  const ts = b?.container?.message_ts ?? b?.message?.ts;
  return typeof channel === 'string' && typeof ts === 'string' ? { channel, ts } : null;
}

/** A per-interaction discriminator for the idempotency key so a double-delivered click
 * collapses to one event while two distinct clicks stay distinct. */
function interactionId(body: unknown, action: unknown): string {
  const a = action as { action_ts?: unknown };
  if (typeof a?.action_ts === 'string' && a.action_ts !== '') return a.action_ts;
  const b = body as { trigger_id?: unknown; container?: { message_ts?: unknown } };
  if (typeof b?.trigger_id === 'string' && b.trigger_id !== '') return b.trigger_id;
  const mt = b?.container?.message_ts;
  return typeof mt === 'string' ? mt : '';
}

/** Read the submitting user's id + display name off a view_submission body. */
function readViewUser(body: unknown): { id: string; name: string } {
  const u = (body as { user?: { id?: string; name?: string; username?: string } })?.user;
  const id = typeof u?.id === 'string' ? u.id : '';
  const name = (typeof u?.name === 'string' && u.name) || (typeof u?.username === 'string' && u.username) || id;
  return { id, name };
}

/** A per-submission discriminator for a view_submission (the view id/hash), so the two
 * delivery EvidenceAttached events collapse on redelivery but distinct submissions stay
 * distinct. Falls back to a fresh uuid when the view carries no id. */
function readViewId(view: unknown): string {
  const v = view as { id?: unknown; hash?: unknown };
  if (typeof v?.id === 'string' && v.id !== '') return v.id;
  if (typeof v?.hash === 'string' && v.hash !== '') return v.hash;
  return randomUUID();
}

/** Read the private_metadata (the round-tripped need id) off a view. */
function readViewMetadata(view: unknown): string {
  const pm = (view as { private_metadata?: unknown })?.private_metadata;
  return typeof pm === 'string' ? pm : '';
}

const ROUND = (n: number): number => Math.round(n * 10000) / 10000;

/** A one-line roster summary for `/relay volunteers` (derived, non-PII fields only). */
function rosterText(list: Volunteer[]): string {
  if (list.length === 0) return 'No volunteers on the roster yet — use `/relay volunteer` to join.';
  const lines = list.map((v) => {
    const skills = v.skills.length > 0 ? v.skills.join(', ') : 'general';
    return `• *${escapeMrkdwn(v.display_name)}* — ${escapeMrkdwn(skills)} · load ${v.active_load}/${v.capacity_per_day}`;
  });
  return `*Volunteer roster* (${list.length})\n${lines.join('\n')}`;
}

/** The contact-reveal ephemeral (the privacy "wow"): a small framed block naming the number, who
 * revealed it, and that the reveal was written to the append-only audit log. Shown ONLY to the
 * clicking coordinator — this is the single surface Relay ever renders a beneficiary number on, and
 * every reveal leaves an audit_log row. Pure over its inputs. */
function revealEphemeralBlocks(publicId: string, contact: string, actorId: string, atIso: string): SlackBlock[] {
  const when = `${atIso.slice(0, 19).replace('T', ' ')} UTC`;
  return [
    section(`🔒 *Beneficiary contact — ${escapeMrkdwn(publicId)}*\n${escapeMrkdwn(contact)}`),
    context(`Revealed by <@${actorId}> · logged to audit_log at ${when} · shared only with you.`),
    divider,
    context('_Relay shows a contact on exactly one surface — this reveal — and records every one._'),
  ];
}

/** Read a user's text off an assistant-thread message payload (ignore bot/system subtypes). */
function readAssistantText(message: unknown): string {
  const m = message as { text?: unknown; subtype?: unknown };
  if (m.subtype !== undefined) return '';
  return typeof m.text === 'string' ? m.text.trim() : '';
}

/** A single normalized token for a synthetic simulator user id (per-persona intake attribution). */
const injectSlug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'sim';

export interface BuiltSlackApp {
  app: App;
  start: () => Promise<void>;
  /** Re-publish every open App Home (used by the live wall-clock drift tick in src/server.ts). */
  refreshHomes: () => Promise<void>;
}

/** The structural slice of Bolt's slash-command `respond` the sitrep/report helpers use. */
type SlashRespond = (message: { response_type?: 'ephemeral' | 'in_channel'; text: string }) => Promise<unknown>;

/** Wire the Bolt app onto the intake pipeline. Returns start() to resolve channels
 * and boot the app (Socket Mode or HTTP). */
export function buildSlackApp(deps: SlackAppDeps): BuiltSlackApp {
  const socketMode = Boolean(deps.appToken);
  const app = new App({
    token: deps.botToken,
    signingSecret: deps.signingSecret,
    socketMode,
    appToken: deps.appToken,
    port: deps.port,
    customRoutes: [
      {
        path: '/healthz',
        method: 'GET',
        handler: (_req, res) => {
          // Deep readiness probe (BUILD-DOC §9): actually query Postgres + PING Redis (short
          // timeouts) so UptimeRobot / the ALB see a dead dependency as 503 instead of the old
          // static 200 that kept a schema-less or Redis-less task in rotation. Never throws out
          // of the route — any probe error resolves to a 503 rather than crashing the server.
          void checkHealth(deps.health ?? {})
            .then((report) => {
              res.writeHead(report.ok ? 200 : 503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ service: 'relay', ...report }));
            })
            .catch((err) => {
              logger.error({ err }, 'healthz: deep check threw (returning 503)');
              res.writeHead(503, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ ok: false, service: 'relay', checks: {} }));
            });
        },
      },
    ],
  });

  const isIntakeChannel = (channelId: string): boolean =>
    deps.roles.intakeChannelId !== '' && channelId === deps.roles.intakeChannelId;

  // A message in #relay-intake → dedupe + enqueue (ack is implicit for events).
  app.message(async ({ message, body, client }) => {
    if (message.subtype !== undefined) return; // ignore edits / bot / system messages
    if (!message.text || !message.user) return;
    if (!isIntakeChannel(message.channel)) return;

    // Permalink is a Slack object reference (a URL), not message content — safe to
    // persist. Best-effort so a lookup failure never blocks intake.
    let permalink: string | undefined;
    try {
      const res = await client.chat.getPermalink({ channel: message.channel, message_ts: message.ts });
      permalink = res.permalink;
    } catch (err) {
      logger.debug({ err, ts: message.ts }, 'intake: getPermalink failed (non-fatal)');
    }

    await handleIntakeMessage(
      {
        eventId: body.event_id,
        teamId: body.team_id,
        channelId: message.channel,
        messageTs: message.ts,
        userId: message.user,
        text: message.text,
        permalink,
      },
      { queue: deps.queue, dedupe: deps.dedupe, isIntakeChannel },
    );
  });

  // --- Live interaction handlers (Jul 6) --------------------------------------
  // Every consequential transition passes a HUMAN actor (body.user.id) so the engine's
  // gates admit it; ack is immediate and the ledger/card work runs after. Card updates
  // and ephemerals go through the notifier (its own Web client); the modal uses the
  // interaction's own client (views.open needs the request's trigger_id).

  const slaMultiplier = deps.slaMultiplier ?? 1;

  const resolvePublicId = async (needId: string): Promise<string> => {
    if (deps.store === undefined) return needId;
    return (await deps.store.getPublicId(needId)) ?? needId;
  };

  const notifyError = async (ctx: { channel?: string; user?: string }, text: string): Promise<void> => {
    if (!ctx.channel || !ctx.user) return;
    try {
      await deps.notifier.postEphemeral({ channel: ctx.channel, user: ctx.user, text });
    } catch (err) {
      logger.debug({ err }, 'error ephemeral failed');
    }
  };

  // Close the loop with the person who reported the need (Moonshot #4). As a need progresses
  // (assigned → en-route → delivered → verified) post a calm, language-matched reply back into the
  // REQUESTER's OWN source thread. Best-effort throughout: a missing source thread or a failed
  // fetch/post is swallowed — this is a courtesy notification, never a consequential transition.
  const notifyRequester = async (
    needId: string,
    kind: RequesterReplyKind,
    opts: { need?: ProjectedNeed | null; etaMinutes?: number | null } = {},
  ): Promise<void> => {
    try {
      const need = opts.need ?? (await deps.service.getNeed(needId));
      if (need === null || need === undefined) return;
      const publicId = await resolvePublicId(needId);
      const vol = need.assigned_volunteer_id
        ? await deps.volunteerStore.getBySlackUser(need.assigned_volunteer_id)
        : null;
      await postRequesterReply({
        notifier: deps.notifier,
        need,
        kind,
        volunteerName: vol?.display_name,
        etaMinutes: opts.etaMinutes,
        publicId,
      });
    } catch (err) {
      logger.debug({ err, need_id: needId, kind }, 'requester reply failed (non-fatal)');
    }
  };

  // Which posted message currently holds each need's dispatch card (channel + ts). A card is
  // first posted by the pipeline worker; from then on every handler that touches a need's card
  // records the ref it just acted on here, so a later interaction can update a need's card even
  // when THIS click was on a different card — e.g. a Merge updates the ORIGINAL's card too, and
  // an Edit view_submission (which carries no card ref of its own) can re-render in place. Purely
  // in-memory view state (rebuilt on restart); a miss degrades gracefully.
  const needCardRefs = new Map<string, CardRef>();
  const rememberCard = (needId: string, ref: CardRef | null): void => {
    if (ref !== null && needId !== '') needCardRefs.set(needId, ref);
  };

  // Pre-warmed backup (Moonshot). For a live obligation (CLAIMED/IN_PROGRESS with an assignee),
  // compute the genuine #1 alternative volunteer via the SAME deterministic scorer the match +
  // reassignment paths use, so the dispatch card can show a standby chip. Best-effort — a scoring
  // hiccup degrades to "no backup" and never blocks the card. Non-delivering needs get null.
  const computeBackupFor = async (need: ProjectedNeed): Promise<BackupCandidate | null> => {
    if (need.state !== 'CLAIMED' && need.state !== 'IN_PROGRESS') return null;
    if (need.assigned_volunteer_id === null) return null;
    try {
      const volunteers = await deps.volunteerStore.list();
      return computeBackup(
        {
          type: need.type,
          localityId: need.locality_id,
          languages: need.languages,
          assignedVolunteerId: need.assigned_volunteer_id,
        },
        volunteers,
        deps.localities,
      );
    } catch (err) {
      logger.debug({ err, need_id: need.need_id }, 'prewarm: computeBackup failed (non-fatal)');
      return null;
    }
  };

  // Best-effort heads-up DM to a pre-warmed backup, only for the urgent needs worth pre-staging
  // (critical|high). Advisory only — the backup is NOT assigned; committing is still the human-gated
  // need_reassign_pick. A Slack failure (e.g. a seed id that can't be DM'd) is swallowed.
  const sendBackupHeadsUp = async (
    need: ProjectedNeed,
    backup: BackupCandidate | null,
    publicId: string,
  ): Promise<void> => {
    if (backup === null) return;
    if (need.severity !== 'critical' && need.severity !== 'high') return;
    const text =
      `Heads-up — you're the pre-warmed backup for ${publicId} (${need.type}, ${need.severity}). ` +
      `No action needed unless a coordinator reassigns it to you.`;
    try {
      await deps.notifier.postDirect(backup.volunteer.slack_user_id, text, [section(text)]);
    } catch (err) {
      logger.debug({ err, need_id: need.need_id }, 'prewarm: backup heads-up DM failed (non-fatal)');
    }
  };

  // --- App Home operations board (F2) -----------------------------------------
  // The live board is PURE over the projection; the integrator owns two bits of view state:
  //   · homeFilters — each viewer's active board filter (a view preference, NOT ledger state).
  //   · homeAudience — every user who has opened the home, so a ledger mutation or a drift tick
  //     can re-publish their board. Both are small in-memory maps (rebuilt on restart).
  const homeFilters = new Map<string, HomeFilter | null>();
  const homeAudience = new Set<string>();

  /** Resolve N-000x labels for the board (memoized per publish; falls back to #<uuid> without a store). */
  const buildPublicIdOf = async (needs: ProjectedNeed[]): Promise<(needId: string) => string | undefined> => {
    if (deps.store === undefined) return () => undefined;
    const map = new Map<string, string>();
    for (const n of needs) {
      const pid = await deps.store.getPublicId(n.need_id);
      if (pid !== null) map.set(n.need_id, pid);
    }
    return (id) => map.get(id);
  };

  /** Publish the operations board to one user with their active filter + the demo SLA clock. */
  const publishHomeFor = async (userId: string): Promise<void> => {
    const needs = await deps.service.listNeeds();
    const publicIdOf = await buildPublicIdOf(needs);
    const opts: HomeViewOptions = {
      now: Date.now(),
      filter: homeFilters.get(userId) ?? null,
      slaMultiplier,
      publicIdOf,
      degraded: getDegrade().llmDisabled,
    };
    await deps.notifier.publishHome(userId, needs, opts);
  };

  /** Re-publish every open App Home (after a ledger mutation or a drift tick). Best-effort. */
  const refreshHomes = async (): Promise<void> => {
    for (const userId of homeAudience) {
      try {
        await publishHomeFor(userId);
      } catch (err) {
        logger.debug({ err, user: userId }, 'app_home: refresh failed');
      }
    }
  };

  // App Home opened → remember the opener and publish their (filtered) board.
  app.event('app_home_opened', async ({ event }) => {
    if (event.tab && event.tab !== 'home') return;
    homeAudience.add(event.user);
    try {
      await publishHomeFor(event.user);
    } catch (err) {
      logger.warn({ err, user: event.user }, 'app_home: publish failed');
    }
  });

  // A filter button → store the viewer's active filter (or clear it on "All") and re-publish
  // just their board. The encoded value round-trips through decodeHomeFilter (homeFilters.ts).
  app.action(/^home_filter:/, async ({ ack, body, action }) => {
    await ack();
    const ctx = readBodyContext(body);
    if (!ctx.user) return;
    const encoded = readActionValue(action) || parseActionId(readActionId(action)).id;
    const filter = decodeHomeFilter(encoded);
    if (filter === null) homeFilters.delete(ctx.user);
    else homeFilters.set(ctx.user, filter);
    homeAudience.add(ctx.user);
    try {
      await publishHomeFor(ctx.user);
    } catch (err) {
      logger.debug({ err, user: ctx.user }, 'app_home: filter republish failed');
    }
  });

  // A View button on the board → DM the clicking user a deep link to the need's source thread
  // (the button value carries the permalink; App Home block actions have no channel to post an
  // ephemeral into, so we open the IM instead). Falls back to pointing at #relay-dispatch.
  app.action(/^home_view:/, async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const value = readActionValue(action);
    const publicId = await resolvePublicId(needId);
    const dispatch = deps.roles.dispatchChannelId;
    const text = value.startsWith('http')
      ? `${publicId} — open its report thread: ${value}`
      : dispatch !== ''
        ? `${publicId} — find its dispatch card in <#${dispatch}>.`
        : `${publicId} — its dispatch card is in #relay-dispatch.`;
    try {
      await deps.notifier.postDirect(ctx.user, text, [section(text)]);
    } catch (err) {
      logger.debug({ err, need_id: needId }, 'home_view deep-link DM failed');
    }
  });

  // Re-render a nudge DM in place after the volunteer taps a button: same heading, an ack
  // line, no more buttons. Best-effort — a failed chat.update never breaks the transition.
  const ackNudge = async (needId: string, body: unknown, ack: NudgeAck): Promise<void> => {
    const ref = readCardRef(body);
    if (ref === null) return;
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    const publicId = await resolvePublicId(needId);
    try {
      await deps.notifier.updateMessage(
        ref,
        `${publicId} update`,
        buildNudgeBlocks(need, publicId, 'at_risk', { ack }),
      );
    } catch (err) {
      logger.debug({ err, need_id: needId }, 'nudge DM update failed');
    }
  };

  // Score the roster for a (now-OPEN) need, emit MatchSuggested, and render the slate
  // under the card. Deterministic scorer; the LLM only phrases each rationale (grounded).
  const runMatch = async (needId: string, ref: ReturnType<typeof readCardRef>): Promise<void> => {
    rememberCard(needId, ref);
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    const publicId = await resolvePublicId(needId);
    const scoreNeed: ScoreNeed = { type: need.type, localityId: need.locality_id, languages: need.languages };
    const volunteers = await deps.volunteerStore.list();
    const top = topN(scoreNeed, volunteers, deps.localities, 3);
    const ranked: RankedCandidate[] = [];
    for (const c of top) ranked.push({ ...c, rationale: await matchRationale(c, scoreNeed, deps.llm) });

    let projection = need;
    if (ranked.length > 0) {
      const res = await deps.service.dispatch(
        needId,
        {
          type: 'MatchSuggested',
          payload: {
            candidates: ranked.map((c) => ({ volunteer_id: c.volunteer.slack_user_id, score: ROUND(c.score) })),
          },
        },
        {
          actor: { type: 'system', id: 'relay-match' },
          at: new Date().toISOString(),
          idempotencyKey: needEventKey(needId, 'MatchSuggested', String(need.history_count)),
        },
      );
      if (res.need !== undefined) projection = res.need;
    }
    if (ref === null) return;
    const events = await deps.service.getEvents(needId);
    const matchNeed: MatchNeed = { needId, publicId, type: projection.type, localityText: projection.location_text };
    await deps.notifier.updateCard(ref, { needId, publicId }, projection, {
      events,
      extraBlocks: buildMatchBlocks(matchNeed, ranked),
    });
  };

  // Confirm triage (human) → OPEN, then run matching and update the card.
  app.action(new RegExp(`^${ACTIONS.confirm}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const confirmed = await deps.service.dispatch(
      needId,
      { type: 'TriageConfirmed', payload: {} },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'TriageConfirmed', interactionId(body, action)),
      },
    );
    if (confirmed.status === 'rejected' || confirmed.status === 'conflict') {
      await notifyError(ctx, `Couldn't confirm that need (${confirmed.code ?? confirmed.status}).`);
      return;
    }
    try {
      await runMatch(needId, readCardRef(body));
    } catch (err) {
      logger.error({ err, need_id: needId }, 'match after confirm failed');
    }
    void refreshHomes(); // the board's counters + attention list moved (TRIAGED → OPEN)
  });

  // The card's plain "Assign" surfaces the volunteer slate once the need is OPEN (from
  // which need_assign_pick commits). Before triage is confirmed there is nothing to
  // assign against, so it guides the coordinator to Confirm first. Assignment itself is
  // always the human-gated need_assign_pick below.
  app.action(new RegExp(`^${ACTIONS.assign}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    if (need.state === 'OPEN' || need.state === 'MATCH_SUGGESTED' || need.state === 'REOPENED') {
      try {
        await runMatch(needId, readCardRef(body));
      } catch (err) {
        logger.error({ err, need_id: needId }, 'match on assign failed');
      }
    } else {
      await notifyError(ctx, 'Confirm triage first — Assign surfaces the volunteer slate once the need is OPEN.');
    }
  });

  // Merge a proposed duplicate (human) → DUPLICATE, then re-render the (duplicate) card.
  app.action(new RegExp(`^${ACTIONS.merge}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: packed } = parseActionId(readActionId(action));
    const { needId, otherNeedId } = parseMergeTarget(packed);
    const ctx = readBodyContext(body);
    if (!needId || !otherNeedId || !ctx.user) return;
    const res = await deps.service.dispatch(
      needId,
      { type: 'DuplicateConfirmed', payload: { merged_into: otherNeedId } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'DuplicateConfirmed', interactionId(body, action)),
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't merge that need (${res.code ?? res.status}).`);
      return;
    }
    const ref = readCardRef(body);
    rememberCard(needId, ref);
    const publicId = await resolvePublicId(needId);
    const otherPublicId = await resolvePublicId(otherNeedId);
    const need = res.need ?? (await deps.service.getNeed(needId));
    if (ref !== null && need !== null) {
      const events = await deps.service.getEvents(needId);
      await deps.notifier.updateCard(ref, { needId, publicId }, need, {
        events,
        publicIdOf: (id) => (id === otherNeedId ? otherPublicId : undefined),
      });
    }
    // Update the ORIGINAL's card too (needId here is the DUPLICATE; otherNeedId is the survivor):
    // its dispatch card should now show the duplicate was linked in. Use the remembered card ref;
    // if the original was never interacted with (unknown ref), degrade to a dispatch-channel note.
    try {
      const mergedNote = context(`🔗 *${escapeMrkdwn(publicId)} merged in* — a duplicate report was linked here.`);
      const originalRef = needCardRefs.get(otherNeedId);
      const original = await deps.service.getNeed(otherNeedId);
      if (originalRef !== undefined && original !== null) {
        const originalEvents = await deps.service.getEvents(otherNeedId);
        await deps.notifier.updateCard(originalRef, { needId: otherNeedId, publicId: otherPublicId }, original, {
          events: originalEvents,
          extraBlocks: [mergedNote],
        });
      } else {
        await deps.notifier.postToDispatch(`${otherPublicId} — duplicate ${publicId} merged in`, [
          section(
            `🔗 *${escapeMrkdwn(publicId)} merged into ${escapeMrkdwn(otherPublicId)}* — tracked as one need now.`,
          ),
        ]);
      }
    } catch (err) {
      logger.debug({ err, need_id: otherNeedId }, 'merge: original-card update failed');
    }
  });

  // Assign a picked volunteer (human) → CLAIMED, stamp the SLA clock, bump their load, and
  // update the card. The obligation's sla_due_at is computed from the per-type SLA table
  // compressed by config.slaMultiplier (§F4) so the drift sweep can chase it.
  app.action(new RegExp(`^${ASSIGN_PICK_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: packed } = parseActionId(readActionId(action));
    const { needId, volunteerId } = parseAssignTarget(packed);
    const ctx = readBodyContext(body);
    if (!needId || !volunteerId || !ctx.user) return;
    const target = await deps.service.getNeed(needId);
    if (target === null) return;
    const nowMs = Date.now();
    const slaDueAt = slaDueAtIso(target.type, target.severity, nowMs, slaMultiplier);
    const res = await deps.service.dispatch(
      needId,
      { type: 'Assigned', payload: { volunteer_id: volunteerId, obligation_id: randomUUID(), sla_due_at: slaDueAt } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date(nowMs).toISOString(),
        idempotencyKey: needEventKey(needId, 'Assigned', interactionId(body, action)),
        now: nowMs,
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't assign that need (${res.code ?? res.status}).`);
      return;
    }
    if (res.status === 'applied') await deps.volunteerStore.incrementLoad(volunteerId, 1);
    const vol = await deps.volunteerStore.getBySlackUser(volunteerId);
    const name = vol?.display_name ?? volunteerId;
    const ref = readCardRef(body);
    rememberCard(needId, ref);
    const need = res.need ?? (await deps.service.getNeed(needId));
    const backup = need !== null ? await computeBackupFor(need) : null;
    if (ref !== null && need !== null) {
      const publicId = await resolvePublicId(needId);
      const events = await deps.service.getEvents(needId);
      await deps.notifier.updateCard(ref, { needId, publicId }, need, {
        events,
        backup,
        extraBlocks: [context(`✅ *Assigned to ${escapeMrkdwn(name)}*`)],
      });
      // Pre-warm the backup: heads-up DM for the urgent needs (best-effort, advisory).
      void sendBackupHeadsUp(need, backup, publicId);
    }
    // Tell the requester help is on the way, in their own thread + language (best-effort).
    await notifyRequester(needId, 'assigned', { need });
    void refreshHomes(); // OPEN → CLAIMED, and a new obligation joins the drift panel
  });

  // Reveal beneficiary contact — the ONE path allowed to surface the number. Ephemeral
  // to the clicker only, never logged, and written to the append-only audit trail.
  app.action(/^need_reveal:/, async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.channel || !ctx.user) return;
    let contact: string | null = null;
    if (deps.vault !== undefined) {
      try {
        contact = await deps.vault.get(needId);
      } catch (err) {
        logger.error({ err, need_id: needId }, 'contact vault read failed');
      }
    }
    if (contact === null) {
      await deps.notifier.postEphemeral({
        channel: ctx.channel,
        user: ctx.user,
        text: 'No contact on file for that need.',
      });
      return;
    }
    const at = new Date().toISOString();
    const publicId = await resolvePublicId(needId);
    await deps.notifier.postEphemeral({
      channel: ctx.channel,
      user: ctx.user,
      text: `🔒 Beneficiary contact for ${publicId}: ${contact} — shared only with you; written to the audit log.`,
      blocks: revealEphemeralBlocks(publicId, contact, ctx.user, at),
    });
    try {
      await deps.auditLog?.record({ actorId: ctx.user, action: 'contact_revealed', subject: needId, meta: { at } });
    } catch (err) {
      logger.error({ err, need_id: needId }, 'audit log write failed for contact reveal');
    }
  });

  // --- Edit / Escalate handlers (§F2 secondary actions) -----------------------
  // The committed card's "✏️ Edit" + "⏫ Escalate" controls. Edit corrects the extracted fields as
  // a HUMAN override (a human-actor ExtractionCompleted the projection applies — severity floor only
  // raises); Escalate records a PII-free ledger comment and raises the need's visibility in #relay-hq.

  // "✏️ Edit" → open the field-correction modal (needs the interaction's trigger_id). The card ref is
  // remembered here so the view_submission (which carries no card coordinates) can re-render in place.
  app.action(new RegExp(`^${NEED_EDIT_ACTION}:`), async ({ ack, body, action, client }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!needId || !triggerId) return;
    rememberCard(needId, readCardRef(body));
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    try {
      const openArgs = {
        trigger_id: triggerId,
        view: buildEditModal(need),
      } as unknown as Parameters<typeof client.views.open>[0];
      await client.views.open(openArgs);
    } catch (err) {
      logger.error({ err, need_id: needId }, 'open edit modal failed');
    }
  });

  // Field-correction submitted → a HUMAN-actor ExtractionCompleted override. The projection applies
  // the corrected fields WITHOUT rewinding the lifecycle (state stays SAME from a committed need) and
  // the severity floor still only-raises (invariant #4). Edited fields are marked 'stated' (a human
  // stated them); the derived `contact` confidence is preserved so the reveal control survives.
  app.view(EDIT_CALLBACK_ID, async ({ ack, view, body }) => {
    await ack();
    const needId = readViewMetadata(view);
    const user = readViewUser(body);
    if (needId === '' || user.id === '') return;
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    const edit = parseEditSubmission(view as unknown as SlackView);
    const confidence: Record<string, ConfidenceStatus> = { ...need.confidence, type: 'stated', severity: 'stated' };
    if (edit.locality_id !== null || edit.location_text !== null) confidence.locality = 'stated';
    if (edit.people_count !== null) confidence.people_count = 'stated';
    try {
      const res = await deps.service.dispatch(
        needId,
        {
          type: 'ExtractionCompleted',
          payload: {
            need_type: edit.need_type,
            severity: edit.severity,
            locality_id: edit.locality_id,
            location_text: edit.location_text,
            people_count: edit.people_count,
            confidence,
          },
        },
        {
          actor: { type: 'human', id: user.id },
          at: new Date().toISOString(),
          idempotencyKey: needEventKey(needId, 'ExtractionCompleted', `edit:${readViewId(view)}`),
        },
      );
      if (res.status === 'rejected' || res.status === 'conflict') {
        logger.warn({ need_id: needId, code: res.code ?? res.status }, 'edit override rejected');
        return;
      }
      const ref = needCardRefs.get(needId);
      const updated = res.need ?? (await deps.service.getNeed(needId));
      if (ref !== undefined && updated !== null) {
        const publicId = await resolvePublicId(needId);
        const events = await deps.service.getEvents(needId);
        await deps.notifier.updateCard(ref, { needId, publicId }, updated, {
          events,
          extraBlocks: [context(`✏️ *Fields corrected by <@${user.id}>* — human override recorded.`)],
        });
      }
      void refreshHomes(); // a correction can move type/severity → the board's counters shift
    } catch (err) {
      logger.error({ err, need_id: needId }, 'edit submission failed');
    }
  });

  // "⏫ Escalate" → a PII-free CommentAdded (human) + a compact repost to #relay-hq with an
  // "escalated by" note. Minimal but real: a durable ledger event plus a real HQ signal, never a no-op.
  app.action(new RegExp(`^${NEED_ESCALATE_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    rememberCard(needId, readCardRef(body));
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    const res = await deps.service.dispatch(
      needId,
      { type: 'CommentAdded', payload: { ref: 'escalated' } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'CommentAdded', `escalate:${interactionId(body, action)}`),
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't escalate that need (${res.code ?? res.status}).`);
      return;
    }
    const publicId = await resolvePublicId(needId);
    const hq = deps.roles.hqChannelId || deps.roles.dispatchChannelId;
    if (hq !== '') {
      const location = need.location_text ? escapeMrkdwn(need.location_text) : '_unknown_';
      const people = need.people_count !== null ? String(need.people_count) : '_unknown_';
      try {
        await deps.notifier.postToChannel(hq, `${publicId} escalated`, [
          section(`⚠️ *${escapeMrkdwn(publicId)} escalated by <@${ctx.user}>* — needs coordinator attention.`),
          fields([
            `*Type:*\n${escapeMrkdwn(need.type)}`,
            `*Severity:*\n${escapeMrkdwn(need.severity)}`,
            `*Location:*\n${location}`,
            `*People:*\n${people}`,
            `*Status:*\n${need.state}`,
          ]),
          context('Escalated from the dispatch card · recorded on the ledger (CommentAdded).'),
        ]);
      } catch (err) {
        logger.error({ err, need_id: needId }, 'escalate: HQ post failed');
      }
    }
    const where = hq !== '' ? ` to <#${hq}>` : '';
    await notifyError(ctx, `⏫ ${publicId} escalated${where} and logged to the ledger.`);
  });

  // --- Drift handlers (Jul 8) -------------------------------------------------
  // The volunteer's nudge-DM replies + the coordinator's one-click reassignment. Each reads
  // body.user.id as the (human) actor; the ledger gates decide, and side effects run post-ack.

  // "On my way" → EnRouteReported → IN_PROGRESS; acknowledge in the DM.
  app.action(new RegExp(`^${ENROUTE_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const res = await deps.service.dispatch(
      needId,
      { type: 'EnRouteReported', payload: {} },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'EnRouteReported', interactionId(body, action)),
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't update that delivery (${res.code ?? res.status}).`);
      return;
    }
    await ackNudge(needId, body, 'en_route');
    // Reassure the requester their volunteer is on the way (best-effort, their thread + language).
    await notifyRequester(needId, 'en_route', { need: res.need });
  });

  // "Delayed" → Nudged{kind:'delayed'}; on the 2nd delay, auto-surface a reassignment card (a
  // human still commits the actual Reassigned by clicking it). delays_count is derived from
  // the log, so a fresh key per click keeps each delay distinct.
  app.action(new RegExp(`^${DELAYED_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const res = await deps.service.dispatch(
      needId,
      { type: 'Nudged', payload: { kind: 'delayed' } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'Nudged', `delayed:${interactionId(body, action)}`),
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't record that delay (${res.code ?? res.status}).`);
      return;
    }
    await ackNudge(needId, body, 'delayed');
    const events = await deps.service.getEvents(needId);
    const delays = events.filter((e) => e.type === 'Nudged' && e.payload.kind === 'delayed').length;
    if (res.status === 'applied' && delays >= 2 && deps.proposeReassign !== undefined) {
      const need = res.need ?? (await deps.service.getNeed(needId));
      if (need !== null) {
        try {
          await deps.proposeReassign(need);
        } catch (err) {
          logger.error({ err, need_id: needId }, 'delayed: proposeReassign failed');
        }
      }
    }
  });

  // "Release" → ClaimReleased → OPEN, then immediately propose a fresh reassignment: the hero
  // one-click hand-off. Decrements the releasing volunteer's load; excludes them from the slate.
  app.action(new RegExp(`^${RELEASE_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const before = await deps.service.getNeed(needId);
    const res = await deps.service.dispatch(
      needId,
      { type: 'ClaimReleased', payload: { volunteer_id: ctx.user, reason: 'volunteer_released' } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'ClaimReleased', interactionId(body, action)),
      },
    );
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't release that need (${res.code ?? res.status}).`);
      return;
    }
    if (res.status === 'applied' && before?.assigned_volunteer_id) {
      await deps.volunteerStore.incrementLoad(before.assigned_volunteer_id, -1);
    }
    await ackNudge(needId, body, 'released');
    const need = res.need ?? (await deps.service.getNeed(needId));
    if (res.status === 'applied' && need !== null && deps.proposeReassign !== undefined) {
      try {
        await deps.proposeReassign(need, ctx.user);
      } catch (err) {
        logger.error({ err, need_id: needId }, 'release: proposeReassign failed');
      }
    }
    void refreshHomes(); // released back to OPEN — it returns to the attention list
  });

  // Coordinator one-click reassignment from a proposal card → the obligation moves to the new
  // volunteer with a fresh SLA. Reassigned when the need is still held (CLAIMED/IN_PROGRESS/
  // REOPENED); Assigned when it was released back to OPEN — both land in CLAIMED, both human.
  app.action(new RegExp(`^${REASSIGN_PICK_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: packed } = parseActionId(readActionId(action));
    const { needId, volunteerId } = parseAssignTarget(packed);
    const ctx = readBodyContext(body);
    if (!needId || !volunteerId || !ctx.user) return;
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    const prevVolunteer = need.assigned_volunteer_id;
    const held = need.state === 'CLAIMED' || need.state === 'IN_PROGRESS' || need.state === 'REOPENED';
    const nowMs = Date.now();
    const slaDueAt = slaDueAtIso(need.type, need.severity, nowMs, slaMultiplier);
    const command = held
      ? ({
          type: 'Reassigned',
          payload: {
            to_volunteer_id: volunteerId,
            from_volunteer_id: prevVolunteer ?? undefined,
            obligation_id: randomUUID(),
            sla_due_at: slaDueAt,
          },
        } as const)
      : ({
          type: 'Assigned',
          payload: { volunteer_id: volunteerId, obligation_id: randomUUID(), sla_due_at: slaDueAt },
        } as const);
    const res = await deps.service.dispatch(needId, command, {
      actor: { type: 'human', id: ctx.user },
      at: new Date(nowMs).toISOString(),
      idempotencyKey: needEventKey(needId, command.type, interactionId(body, action)),
      now: nowMs,
    });
    if (res.status === 'rejected' || res.status === 'conflict') {
      await notifyError(ctx, `Couldn't reassign that need (${res.code ?? res.status}).`);
      return;
    }
    if (res.status === 'applied') {
      await deps.volunteerStore.incrementLoad(volunteerId, 1);
      if (held && prevVolunteer) await deps.volunteerStore.incrementLoad(prevVolunteer, -1);
    }
    const vol = await deps.volunteerStore.getBySlackUser(volunteerId);
    const name = vol?.display_name ?? volunteerId;
    const ref = readCardRef(body);
    rememberCard(needId, ref);
    const updated = res.need ?? (await deps.service.getNeed(needId));
    const backup = updated !== null ? await computeBackupFor(updated) : null;
    if (ref !== null && updated !== null) {
      const publicId = await resolvePublicId(needId);
      const events = await deps.service.getEvents(needId);
      await deps.notifier.updateCard(ref, { needId, publicId }, updated, {
        events,
        backup,
        extraBlocks: [context(`🔄 *Reassigned to ${escapeMrkdwn(name)}* — fresh SLA clock started.`)],
      });
      // Re-warm the backup for the NEW holder (excludes them from the fresh backup pool).
      void sendBackupHeadsUp(updated, backup, publicId);
    }
    void refreshHomes(); // the obligation moved to a new volunteer with a fresh SLA
  });

  // --- Evidence / verification handlers (Jul 8) -------------------------------
  // The F5 close loop. Mark delivered opens the evidence modal; its submission attaches L1
  // (photo + locality) → DELIVERED_UNVERIFIED and posts a recipient-confirm prompt; recipient
  // (or coordinator-substitute) confirmation adds L2; the coordinator's sign-off adds L3 and,
  // ONLY when meetsVerificationPolicy holds, Verifies then Closes. Every consequential step
  // (sign-off / verify / close) passes a HUMAN actor; evidence attaches store references only,
  // never beneficiary content (zero-copy, invariant #5).

  // Re-render a need's dispatch card in place with its current evidence/verification state
  // (the packet + badge + closed banner are part of the card once it is a delivery state).
  const renderEvidenceCard = async (needId: string, body: unknown, prefetched?: ProjectedNeed): Promise<void> => {
    const ref = readCardRef(body);
    if (ref === null) return;
    rememberCard(needId, ref);
    const need = prefetched ?? (await deps.service.getNeed(needId));
    if (need === null) return;
    const publicId = await resolvePublicId(needId);
    const events = await deps.service.getEvents(needId);
    const backup = await computeBackupFor(need);
    try {
      await deps.notifier.updateCard(ref, { needId, publicId }, need, { events, backup });
    } catch (err) {
      logger.debug({ err, need_id: needId }, 'evidence card update failed');
    }
  };

  // "Mark delivered" → open the evidence-capture modal (needs the interaction's trigger_id).
  app.action(new RegExp(`^${MARK_DELIVERED_ACTION}:`), async ({ ack, body, action, client }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!needId || !triggerId) return;
    try {
      const openArgs = {
        trigger_id: triggerId,
        view: buildDeliveryModal(needId),
      } as unknown as Parameters<typeof client.views.open>[0];
      await client.views.open(openArgs);
    } catch (err) {
      logger.error({ err, need_id: needId }, 'open delivery modal failed');
    }
  });

  // Delivery evidence submitted → attach L1 (photo when referenced, locality when confirmed) →
  // DELIVERED_UNVERIFIED, then post a recipient-confirm prompt so the loop can be closed. The
  // card refreshes on its next interaction (the needId→cardRef index is a documented seam).
  app.view(DELIVERY_CALLBACK_ID, async ({ ack, view, body }) => {
    await ack();
    const needId = readViewMetadata(view);
    const user = readViewUser(body);
    if (needId === '' || user.id === '') return;
    const submission = parseDeliverySubmission(view as unknown as SlackView);
    const disc = readViewId(view);
    try {
      let attached = false;
      if (submission.photoRef !== undefined) {
        await deps.service.dispatch(
          needId,
          {
            type: 'EvidenceAttached',
            payload: { kind: 'photo', evidence_id: submission.photoRef, meta: { via: 'modal' } },
          },
          {
            actor: { type: 'agent', id: user.id },
            at: new Date().toISOString(),
            idempotencyKey: needEventKey(needId, 'EvidenceAttached', `photo:${disc}`),
          },
        );
        attached = true;
      }
      if (submission.localityConfirmed) {
        await deps.service.dispatch(
          needId,
          { type: 'EvidenceAttached', payload: { kind: 'locality_confirm', meta: { via: 'modal' } } },
          {
            actor: { type: 'agent', id: user.id },
            at: new Date().toISOString(),
            idempotencyKey: needEventKey(needId, 'EvidenceAttached', `locality:${disc}`),
          },
        );
        attached = true;
      }
      if (attached) {
        const publicId = await resolvePublicId(needId);
        await deps.notifier.postToDispatch(
          `${publicId} delivery reported — confirm receipt`,
          buildRecipientConfirmPrompt(needId),
        );
        // Let the requester know help arrived and confirmation is pending (best-effort, their thread).
        await notifyRequester(needId, 'delivered');
      }
    } catch (err) {
      logger.error({ err, need_id: needId }, 'delivery evidence submission failed');
    }
  });

  // Recipient confirmation (recipient self-confirm OR coordinator substitute) → RecipientConfirmed
  // (+ an evidence ref) → L2. Neither is human-gated; the substitute path is attributed to the
  // clicking coordinator and logs a reason.
  const confirmRecipient = async (
    needId: string,
    ctx: { channel?: string; user?: string },
    body: unknown,
    action: unknown,
    by: 'recipient' | 'coordinator_substitute',
  ): Promise<void> => {
    const user = ctx.user;
    if (!user) return;
    const disc = interactionId(body, action);
    const actor =
      by === 'coordinator_substitute' ? ({ type: 'human', id: user } as const) : ({ type: 'agent', id: user } as const);
    const rc = await deps.service.dispatch(
      needId,
      {
        type: 'RecipientConfirmed',
        payload:
          by === 'coordinator_substitute'
            ? { confirmed_by: 'coordinator_substitute', reason: 'coordinator_confirmed_on_behalf' }
            : { confirmed_by: 'recipient' },
      },
      { actor, at: new Date().toISOString(), idempotencyKey: needEventKey(needId, 'RecipientConfirmed', disc) },
    );
    if (rc.status === 'rejected' || rc.status === 'conflict') {
      await notifyError(ctx, `Couldn't confirm receipt (${rc.code ?? rc.status}).`);
      return;
    }
    await deps.service.dispatch(
      needId,
      { type: 'EvidenceAttached', payload: { kind: 'recipient_confirm', meta: { via: by } } },
      {
        actor,
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'EvidenceAttached', `recipient:${disc}`),
      },
    );
    if (by === 'coordinator_substitute') {
      logger.info({ need_id: needId, by: user }, 'recipient confirmation recorded via coordinator substitute');
    }
    await renderEvidenceCard(needId, body);
  };

  app.action(new RegExp(`^${RECIPIENT_CONFIRM_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    await confirmRecipient(needId, ctx, body, action, 'recipient');
  });

  app.action(new RegExp(`^${RECIPIENT_SUBSTITUTE_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    await confirmRecipient(needId, ctx, body, action, 'coordinator_substitute');
  });

  // Coordinator "Sign off & close" → attach L3 (coordinator_signoff) + CoordinatorSignedOff
  // (human). Then, ONLY when meetsVerificationPolicy holds, Verified (human) → Closed (human).
  // If the packet is short, ack with the missing kinds; a premature Verified the engine would
  // reject anyway is avoided (and handled defensively).
  app.action(new RegExp(`^${SIGNOFF_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: needId } = parseActionId(readActionId(action));
    const ctx = readBodyContext(body);
    if (!needId || !ctx.user) return;
    const need = await deps.service.getNeed(needId);
    if (need === null) return;
    rememberCard(needId, readCardRef(body));
    // Guard FIRST (fixes the locked-button bug): a click into an incomplete packet must record
    // NOTHING. Slack has no truly-disabled button, so the handler — not the render — is the gate:
    // if everything the severity policy needs BEFORE the sign-off isn't attached, ack + an
    // ephemeral naming the missing kinds, and do not dispatch coordinator_signoff / CoordinatorSignedOff.
    const gate = canSignOff(need);
    if (!gate.allowed) {
      const missing = gate.missing.map((k) => EVIDENCE_KIND_LABEL[k]).join(', ');
      await notifyError(
        ctx,
        `Can't close yet — missing: ${missing || 'more evidence'}. Attach the full packet before signing off.`,
      );
      await renderEvidenceCard(needId, body, need);
      return;
    }
    const disc = interactionId(body, action);
    // Prerequisites present → attach L3 sign-off + CoordinatorSignedOff (human), then Verified → Closed.
    await deps.service.dispatch(
      needId,
      { type: 'EvidenceAttached', payload: { kind: 'coordinator_signoff', meta: { via: 'signoff' } } },
      {
        actor: { type: 'agent', id: 'relay-evidence' },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'EvidenceAttached', `signoff:${disc}`),
      },
    );
    const signed = await deps.service.dispatch(
      needId,
      { type: 'CoordinatorSignedOff', payload: {} },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'CoordinatorSignedOff', disc),
      },
    );
    if (signed.status === 'rejected' || signed.status === 'conflict') {
      await notifyError(ctx, `Couldn't sign off (${signed.code ?? signed.status}).`);
      await renderEvidenceCard(needId, body);
      return;
    }
    const verified = await deps.service.dispatch(
      needId,
      { type: 'Verified', payload: {} },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'Verified', disc),
      },
    );
    if (verified.status === 'rejected' || verified.status === 'conflict') {
      await notifyError(ctx, `Couldn't verify (${verified.code ?? verified.status}).`);
      await renderEvidenceCard(needId, body);
      return;
    }
    await deps.service.dispatch(
      needId,
      { type: 'Closed', payload: {} },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'Closed', disc),
      },
    );
    await renderEvidenceCard(needId, body);
    // Thank the requester and confirm their need is verified + closed (best-effort, their thread).
    await notifyRequester(needId, 'verified');
    void refreshHomes(); // VERIFIED → CLOSED bumps the "verified in the last 24h" counter
  });

  // --- Click-to-audit the donor report (Moonshot #6) --------------------------
  // A 🔍 Audit button under a report figure → post the redacted, ledger-derived evidence chain
  // behind that number, ephemerally to the clicker ("the proof behind this number"). READ-ONLY over
  // the ledger and PII-free by construction: buildAuditTrail redacts every event to its type,
  // evidence kind, timestamp, and actor ROLE only — never a name, contact, note, or file reference.
  app.action(new RegExp(`^${REPORT_AUDIT_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const ctx = readBodyContext(body);
    const { figureKey, needIds } = decodeFigureAudit(readActionValue(action));
    if (!ctx.channel || !ctx.user || needIds.length === 0) return;
    const blocks: SlackBlock[] = [
      section(`🔍 *The proof behind “${escapeMrkdwn(figureKey)}”* — redacted, read-only, straight from the ledger.`),
    ];
    // Cap the needs rendered so the ephemeral stays well under Slack's 100-block ceiling.
    for (const needId of needIds.slice(0, 3)) {
      try {
        const events = await deps.service.getEvents(needId);
        if (events.length === 0) continue;
        const publicId = await resolvePublicId(needId);
        blocks.push(...buildAuditTrail(publicId, events, { limit: 14 }), divider);
      } catch (err) {
        logger.debug({ err, need_id: needId }, 'report audit: getEvents failed');
      }
    }
    if (needIds.length > 3) blocks.push(context(`…and ${needIds.length - 3} more need(s) behind this figure.`));
    try {
      await deps.notifier.postEphemeral({
        channel: ctx.channel,
        user: ctx.user,
        text: 'The proof behind this number',
        blocks,
      });
    } catch (err) {
      logger.error({ err, figure: figureKey }, 'report audit ephemeral failed');
    }
  });

  // --- Judge experience (F8) --------------------------------------------------
  // #judges-start-here on-ramp: a "Run flood demo" button that plays the scenario into
  // #relay-intake as the 🧪 simulator (the REAL pipeline triages it), an idempotent "Reset",
  // and ephemeral "Guided tour" / "Architecture" cards. The same actions are reachable via
  // `/relay demo start|reset`. All demo state is is_demo-flagged (CLAUDE.md 10).

  /** Post arbitrary blocks as an ephemeral (only the clicking judge sees it — no channel clutter). */
  const postEphemeralBlocks = async (
    client: WebClient,
    channel: string,
    user: string,
    text: string,
    blocks: SlackBlock[],
  ): Promise<void> => {
    const args = { channel, user, text, blocks } as unknown as Parameters<typeof client.chat.postEphemeral>[0];
    await client.chat.postEphemeral(args);
  };

  /** (Re)publish the judge welcome card to #judges-start-here (no-op when it isn't resolvable). */
  const publishJudgeWelcome = async (): Promise<void> => {
    const channel = deps.roles.judgesChannelId;
    if (channel === '') return;
    const blocks = buildJudgeWelcome();
    // Surface the AI-DEGRADED banner on the judge on-ramp while the LLM is unplugged (Moonshot #1),
    // so a judge who ran "/relay demo degrade llm" always sees Relay is running on heuristics.
    if (getDegrade().llmDisabled) {
      blocks.splice(
        1,
        0,
        section(`${DEGRADED_BANNER} — extraction is heuristic-only; ambiguous reports honestly route to NEEDS_REVIEW.`),
      );
    }
    try {
      await deps.notifier.postToChannel(channel, 'Relay — judges, start here', blocks);
    } catch (err) {
      logger.warn({ err }, 'judge welcome publish failed');
    }
  };

  /** Post a labelled 🧪 note into a channel as the Relay Simulator identity (demo staging is always
   * visibly marked — CLAUDE.md 10). Best-effort; a Slack failure never breaks the caller. */
  const postSimulatorNote = async (channel: string, text: string): Promise<void> => {
    if (channel === '') return;
    try {
      await app.client.chat.postMessage({ channel, text, username: SIMULATOR_IDENTITY, icon_emoji: ':test_tube:' });
    } catch (err) {
      logger.debug({ err }, 'demo: simulator note failed');
    }
  };

  // Post one simulated intake message into #relay-intake as the 🧪 persona, then feed the SAME
  // intake path a real user message takes (the round-tripped bot_message event is dropped by the
  // subtype filter, and needCreatedKey would collapse it anyway — so no double processing).
  const injectorPostMessage: InjectorPostMessage = async (text, { personaName }) => {
    const channel = deps.roles.intakeChannelId;
    if (channel === '') return;
    const res = await app.client.chat.postMessage({ channel, text, username: personaName, icon_emoji: ':test_tube:' });
    const ts = typeof res.ts === 'string' ? res.ts : '';
    if (ts === '') return;
    let permalink: string | undefined;
    try {
      permalink = (await app.client.chat.getPermalink({ channel, message_ts: ts })).permalink;
    } catch (err) {
      logger.debug({ err }, 'judge inject: getPermalink failed (non-fatal)');
    }
    await handleIntakeMessage(
      {
        eventId: `judge-inject:${channel}:${ts}`,
        teamId: '',
        channelId: channel,
        messageTs: ts,
        userId: `sim_${injectSlug(personaName)}`,
        text,
        permalink,
      },
      { queue: deps.queue, dedupe: deps.dedupe, isIntakeChannel },
    );
  };

  /** The channel a hero-narration line lands in. There is no separate volunteers channel — the
   * per-volunteer nudge itself is a DM fired by the drift sweep; the 'volunteers' narration lines
   * (context for judges) surface in #relay-dispatch alongside the dispatch traffic. */
  const narrateChannelFor = (channel: NarrateChannel): string => {
    if (channel === 'hq') return deps.roles.hqChannelId || deps.roles.dispatchChannelId;
    return deps.roles.dispatchChannelId || deps.roles.intakeChannelId;
  };

  /**
   * The LIVE self-serve hero demo (BUILD-DOC §F5, the never-cut hero moment). Drives the FULL
   * signature sequence — flood → triage → assign → drift nudge → release/reassign → deliver →
   * verify → close — against the REAL ledger + pipeline, narrated as the 🧪 simulator, so a judge
   * who presses "Run flood demo" watches the whole arc happen live (not just the 14 intake posts).
   * Fire-and-forget after ack; every consequential transition carries the clicking human as actor.
   */
  const runLiveHero = async (demoActorId: string): Promise<void> => {
    const scenario = deps.demoScenario;
    if (scenario === undefined || deps.roles.intakeChannelId === '') return;
    const heroDeps: LiveHeroDemoDeps = {
      scenario,
      service: deps.service,
      volunteerStore: deps.volunteerStore,
      localities: deps.localities,
      postIntake: async ({ scenario: s }) => {
        await runFloodInjector({ scenario: s, postMessage: injectorPostMessage });
      },
      driftSweep: async (now) => {
        if (deps.driftSweep !== undefined) await deps.driftSweep(now);
      },
      narrate: async (channel, text) => {
        const target = narrateChannelFor(channel);
        if (target === '') return;
        try {
          await app.client.chat.postMessage({
            channel: target,
            text,
            username: SIMULATOR_IDENTITY,
            icon_emoji: ':test_tube:',
          });
        } catch (err) {
          logger.debug({ err }, 'live hero: narrate failed');
        }
      },
      pickTarget: async (predicate) => (await deps.service.listNeeds(Date.now())).find(predicate) ?? null,
      resolvePublicId,
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      demoActor: { type: 'human', id: demoActorId },
    };
    const { beats } = await runLiveHeroDemo(heroDeps);
    logger.info({ beats }, 'live hero demo complete');
    await refreshHomes();
  };

  /** Idempotent demo teardown: purge is_demo state (when a store is wired), republish App Home for
   * the clicking judge, and refresh the welcome card. Safe to run repeatedly. */
  const runJudgeReset = async (userId?: string): Promise<ResetDemoResult> => {
    const republishHome = async (): Promise<void> => {
      if (userId === undefined) return;
      homeAudience.add(userId);
      try {
        await publishHomeFor(userId);
      } catch (err) {
        logger.debug({ err }, 'judge reset: republish home failed');
      }
    };
    const result = await resetDemo({ store: deps.demoResetStore, purgeIsDemo: true, republishHome });
    await publishJudgeWelcome();
    return result;
  };

  app.action(JUDGE_RUN_DEMO, async ({ ack, body }) => {
    await ack();
    const ctx = readBodyContext(body);
    const scenario = deps.demoScenario;
    if (scenario === undefined || deps.roles.intakeChannelId === '') {
      await notifyError(ctx, 'The flood demo is not configured here (no scenario / unresolved #relay-intake channel).');
      return;
    }
    const count = scenario.steps.filter((s) => s.kind === 'intake_message').length;
    const actorId = ctx.user ?? 'DEMO_COORDINATOR';
    if (ctx.user !== undefined) homeAudience.add(ctx.user);
    await notifyError(
      ctx,
      `▶ Flood demo starting — ${count} simulated reports (🧪 ${SIMULATOR_IDENTITY}) arrive in ` +
        `<#${deps.roles.intakeChannelId}>, then Relay drives the full arc live: triage → assign → ` +
        `SLA drift → one-click reassign → evidence close, narrated as it happens. ` +
        compressedClockNote(scenario.sla_multiplier),
    );
    // Fire-and-forget after ack (Ack < 3s, work async): the self-serve hero runs for a few minutes.
    void runLiveHero(actorId).catch((err) => logger.error({ err }, 'judge live hero run failed'));
  });

  app.action(JUDGE_RESET, async ({ ack, body }) => {
    await ack();
    const ctx = readBodyContext(body);
    try {
      const result = await runJudgeReset(ctx.user);
      const summary = result.noop
        ? 'the board was already clear'
        : `purged ${result.purged.needs} need(s) / ${result.purged.events} event(s)`;
      await notifyError(ctx, `↺ Demo reset — ${summary}. App Home + the judge welcome are refreshed.`);
    } catch (err) {
      logger.error({ err }, 'judge reset failed');
      await notifyError(ctx, 'Could not reset the demo — see logs.');
    }
  });

  app.action(JUDGE_TOUR, async ({ ack, body, client }) => {
    await ack();
    const ctx = readBodyContext(body);
    if (!ctx.channel || !ctx.user) return;
    try {
      await postEphemeralBlocks(client, ctx.channel, ctx.user, 'Relay — guided tour', buildGuidedTour());
    } catch (err) {
      logger.error({ err }, 'judge tour failed');
    }
  });

  app.action(JUDGE_ARCH, async ({ ack, body, client }) => {
    await ack();
    const ctx = readBodyContext(body);
    if (!ctx.channel || !ctx.user) return;
    try {
      await postEphemeralBlocks(client, ctx.channel, ctx.user, 'Relay — architecture', buildArchitecture());
    } catch (err) {
      logger.error({ err }, 'judge arch failed');
    }
  });

  // --- Assistant pane (Slack AI) ----------------------------------------------
  // Ask-Relay answers a coordinator's question grounded in the PII-free ledger (+ optional RTS).
  // A user token lights up live Real-Time Search; without one the deterministic mock keeps the
  // seam wired and answers stay ledger-only (CLAUDE.md §9 honesty). LLM synthesis via P-7 when a
  // key is configured (deps.llm), else the deterministic template path inside askRelay.
  const assistantRts: RtsResolver = deps.slackUserToken
    ? new RtsClient({ client: app.client, userToken: deps.slackUserToken })
    : createMockRts({});
  const suggestedPrompts = [
    { title: 'Open critical needs', message: 'Any critical needs still open?' },
    { title: 'Who is drifting?', message: 'Which obligations are past their SLA right now?' },
    { title: 'Sitrep', message: 'Give me the current situation report.' },
  ];

  const assistant = new Assistant({
    threadStarted: async ({ setSuggestedPrompts }) => {
      try {
        await setSuggestedPrompts({ title: 'Ask Relay about live operations', prompts: suggestedPrompts });
      } catch (err) {
        logger.warn({ err }, 'assistant: setSuggestedPrompts failed');
      }
    },
    userMessage: async ({ message, say, setStatus }) => {
      const question = readAssistantText(message);
      if (question === '') return;
      try {
        await setStatus('Reading the ledger…');
      } catch (err) {
        logger.debug({ err }, 'assistant: setStatus failed');
      }
      try {
        const result = await askRelay({
          question,
          service: deps.service,
          llm: deps.llm,
          rts: assistantRts,
          now: Date.now(),
        });
        // A refusal (out-of-scope OR the emergency-dispatch safety line) renders the answer alone —
        // no citations. In-scope answers get the structured source list from buildAssistantAnswer.
        const refusal = result.intent === 'out-of-scope' || result.intent === 'emergency';
        const blocks = buildAssistantAnswer({
          answer: result.answer,
          citations: result.citations,
          outOfScope: refusal,
        });
        await say({ text: result.answer, blocks } as unknown as Parameters<typeof say>[0]);
      } catch (err) {
        logger.error({ err }, 'assistant: askRelay failed');
        await say('I hit an error reading the ledger — try again in a moment.');
      }
    },
  });
  app.assistant(assistant);

  // The channel sitreps/reports post to (#relay-hq, falling back to #relay-dispatch).
  const hqChannel = (): string => deps.roles.hqChannelId || deps.roles.dispatchChannelId;

  // /relay sitrep → post the live board snapshot (F6) to #relay-hq + best-effort Canvas.
  const runSitrep = async (client: WebClient, respond: SlashRespond): Promise<void> => {
    const channel = hqChannel();
    if (channel === '') {
      await respond({
        response_type: 'ephemeral',
        text: 'No HQ channel resolved — set RELAY_HQ_CHANNEL or invite the bot to #relay-hq / #relay-dispatch.',
      });
      return;
    }
    // Degrade honours the toggle: with the AI unplugged, narration falls back to the deterministic
    // template (narrationLlmFor → undefined) instead of the LLM.
    const now = Date.now();
    const narrateLlm = narrationLlmFor(deps.llm, getDegrade().llmDisabled);
    const sitrep = await generateSitrep({ service: deps.service, llm: narrateLlm, now });
    const posted = await deps.notifier.postToChannel(channel, sitrep.text, sitrep.blocks);
    // Best-effort ops-map garnish: plot the live needs onto the fictional gazetteer and upload the
    // SVG threaded under the sitrep. Wrapped so ANY failure (upload error, no uploader) never breaks
    // the sitrep. Uses ONLY fictional gazetteer coordinates + the ledger's derived fields (no PII).
    try {
      const mapNeeds = await deps.service.listNeeds(now);
      const svg = buildOpsMapSvg(mapNeeds, deps.localities);
      const uploader = client as unknown as {
        files?: { uploadV2?: (a: Record<string, unknown>) => Promise<unknown> };
      };
      if (typeof uploader.files?.uploadV2 === 'function') {
        await uploader.files.uploadV2({
          channel_id: channel,
          thread_ts: posted.ts || undefined,
          filename: 'relay-ops-map.svg',
          title: 'Relay — live operations map (fictional gazetteer)',
          content: svg,
        });
      }
    } catch (err) {
      logger.warn({ err }, 'sitrep: ops-map upload failed (non-fatal)');
    }
    await writeCanvas(client as unknown as CanvasWriteClient, {
      channelId: channel,
      title: 'Relay sitrep',
      markdown: buildCanvasDocument(sitrep.blocks).markdown,
    });
    await respond({ response_type: 'ephemeral', text: `Sitrep posted to <#${channel}> (source: ${sitrep.source}).` });
  };

  // /relay report [period] → post a verified-impact summary (F7) + the Markdown artifact to
  // #relay-hq + best-effort Canvas. The Markdown is the primary artifact; upload + Canvas are
  // both best-effort and never block the summary.
  const runReport = async (client: WebClient, respond: SlashRespond, arg: string): Promise<void> => {
    const channel = hqChannel();
    if (channel === '') {
      await respond({
        response_type: 'ephemeral',
        text: 'No HQ channel resolved — set RELAY_HQ_CHANNEL or invite the bot to #relay-hq / #relay-dispatch.',
      });
      return;
    }
    const now = Date.now();
    const report = await generateReport({
      service: deps.service,
      llm: narrationLlmFor(deps.llm, getDegrade().llmDisabled),
      period: parseReportPeriod(arg, now),
      now,
      resolvePublicId,
    });
    // Append the 🔍 Audit panel (Moonshot #6): one control per headline figure whose click reveals
    // the redacted evidence chain behind that number. Pure over the report's own (need-id-backed)
    // stats; empty when nothing is verified yet, so it never adds a dead button.
    const auditPanel = buildReportAuditPanel(report.stats);
    await deps.notifier.postToChannel(channel, report.text, [...report.blocks, ...auditPanel]);
    // Best-effort: upload the Markdown as a file snippet (never blocks the summary).
    const uploader = client as unknown as {
      files?: { uploadV2?: (a: Record<string, unknown>) => Promise<unknown> };
    };
    if (typeof uploader.files?.uploadV2 === 'function') {
      try {
        await uploader.files.uploadV2({
          channel_id: channel,
          filename: 'relay-verified-impact-report.md',
          title: 'Relay verified-impact report',
          content: report.markdown,
        });
      } catch (err) {
        logger.warn({ err }, 'report: markdown upload failed (non-fatal)');
      }
    }
    await writeCanvas(client as unknown as CanvasWriteClient, {
      channelId: channel,
      title: 'Relay verified-impact report',
      markdown: report.markdown,
    });
    await respond({ response_type: 'ephemeral', text: `Report posted to <#${channel}> (source: ${report.source}).` });
  };

  // /relay demo start flood-1 → play the flood into #relay-intake as the 🧪 simulator (keyboard
  // equivalent of the judge "Run flood demo" button) · /relay demo reset → idempotent teardown ·
  // /relay demo degrade llm|off → unplug/reconnect the AI (Moonshot #1, honest degradation).
  const runDemoCommand = async (
    which: string,
    mode: string,
    channelId: string,
    respond: SlashRespond,
    userId: string,
  ): Promise<void> => {
    if (which === 'degrade') {
      let on: boolean;
      if (mode === 'llm') on = true;
      else if (mode === 'off') on = false;
      else {
        await respond({
          response_type: 'ephemeral',
          text: 'Usage: `/relay demo degrade llm` unplugs the AI (heuristic extraction + template narration) · `/relay demo degrade off` reconnects it.',
        });
        return;
      }
      setDegrade(on);
      const banner = degradeBanner();
      await respond({
        response_type: 'ephemeral',
        text: on
          ? `${banner} — extraction is now heuristic-only and sitrep/report narration uses the deterministic template. New reports will honestly route more needs to NEEDS_REVIEW. Run \`/relay demo degrade off\` to reconnect.`
          : `${banner} — the LLM is reconnected for extraction + narration.`,
      });
      // A labelled 🧪 note in-channel so judges see the AI was toggled, not just the clicker.
      await postSimulatorNote(
        channelId,
        on
          ? `🧪 ${DEGRADED_BANNER} — a judge unplugged the AI. Relay keeps running on deterministic heuristics; watch new reports route to NEEDS_REVIEW.`
          : '🧪 AI reconnected — extraction + narration are back on the LLM.',
      );
      void refreshHomes(); // flip the App Home degrade banner for every open board
      await publishJudgeWelcome(); // flip the banner on the judge on-ramp
      return;
    }
    if (which === 'start') {
      const scenario = deps.demoScenario;
      if (scenario === undefined || deps.roles.intakeChannelId === '') {
        await respond({
          response_type: 'ephemeral',
          text: 'The flood demo is not configured here (no scenario / unresolved #relay-intake channel).',
        });
        return;
      }
      const count = scenario.steps.filter((s) => s.kind === 'intake_message').length;
      homeAudience.add(userId);
      await respond({
        response_type: 'ephemeral',
        text:
          `▶ Flood demo starting — ${count} simulated reports (🧪 ${SIMULATOR_IDENTITY}) arrive in ` +
          `<#${deps.roles.intakeChannelId}>, then Relay drives the full arc live: triage → assign → SLA drift → ` +
          `one-click reassign → evidence close, narrated as it happens. ${compressedClockNote(scenario.sla_multiplier)}`,
      });
      void runLiveHero(userId).catch((err) => logger.error({ err }, 'demo start command live hero failed'));
    } else if (which === 'reset') {
      const result = await runJudgeReset(userId);
      const summary = result.noop
        ? 'the board was already clear'
        : `purged ${result.purged.needs} need(s) / ${result.purged.events} event(s)`;
      await respond({ response_type: 'ephemeral', text: `↺ Demo reset — ${summary}. App Home + welcome refreshed.` });
    } else {
      await respond({
        response_type: 'ephemeral',
        text: 'Usage: `/relay demo start flood-1` · `/relay demo reset` · `/relay demo degrade llm` | `off`.',
      });
    }
  };

  // /relay volunteer → onboarding modal · /relay volunteers → roster · /relay sitrep → F6 ·
  // /relay report [period] → F7 · /relay demo start|reset → F8 judge demo.
  app.command('/relay', async ({ command, ack, respond, client }) => {
    await ack();
    const parts = (command.text ?? '').trim().split(/\s+/);
    const sub = parts[0]?.toLowerCase() ?? '';
    const arg = parts.slice(1).join(' ');
    try {
      if (sub === 'volunteer') {
        const existing = await deps.volunteerStore.getBySlackUser(command.user_id);
        const openArgs = {
          trigger_id: command.trigger_id,
          view: buildVolunteerModal(existing ?? undefined),
        } as unknown as Parameters<typeof client.views.open>[0];
        await client.views.open(openArgs);
      } else if (sub === 'volunteers') {
        const list = await deps.volunteerStore.list();
        await respond({ response_type: 'ephemeral', text: rosterText(list) });
      } else if (sub === 'sitrep') {
        await runSitrep(client, respond);
      } else if (sub === 'report') {
        await runReport(client, respond, arg);
      } else if (sub === 'demo') {
        await runDemoCommand(
          parts[1]?.toLowerCase() ?? '',
          parts[2]?.toLowerCase() ?? '',
          command.channel_id,
          respond,
          command.user_id,
        );
      } else {
        await respond({
          response_type: 'ephemeral',
          text: 'Usage: `/relay volunteer` join/update · `/relay volunteers` roster · `/relay sitrep` live board · `/relay report [24h|7d|30d]` verified-impact report · `/relay demo start flood-1` | `reset` | `degrade llm`|`off` judge demo.',
        });
      }
    } catch (err) {
      logger.error({ err, sub }, 'relay command failed');
    }
  });

  // Volunteer onboarding submission → upsert into the roster.
  app.view(VOLUNTEER_CALLBACK_ID, async ({ ack, view, body }) => {
    await ack();
    try {
      const submission = parseVolunteerSubmission(view as unknown as SlackView);
      const user = readViewUser(body);
      if (user.id === '') return;
      await deps.volunteerStore.upsert({
        slack_user_id: user.id,
        display_name: user.name,
        skills: submission.skills,
        languages: submission.languages,
        home_locality: submission.home_locality,
        radius_km: submission.radius_km,
        capacity_per_day: submission.capacity_per_day,
        availability: submission.availability,
        active_load: 0,
        is_demo: deps.isDemo ?? false,
      });
      logger.info(
        { volunteer: user.id, skills: submission.skills.length, home_locality: submission.home_locality },
        'volunteer onboarded',
      );
    } catch (err) {
      logger.error({ err }, 'volunteer onboard failed');
    }
  });

  // Global safety net so a listener exception is never swallowed.
  app.error(async (error) => {
    logger.error({ err: error }, 'slack listener error');
  });

  const start = async (): Promise<void> => {
    await resolveRoles(app.client, deps.roles, deps.channelConfig ?? {});
    if (deps.roles.intakeChannelId === '' || deps.roles.dispatchChannelId === '') {
      logger.warn(
        { intake: deps.roles.intakeChannelId, dispatch: deps.roles.dispatchChannelId },
        'relay: could not resolve both channels — set RELAY_INTAKE_CHANNEL / RELAY_DISPATCH_CHANNEL or invite the bot to #relay-intake / #relay-dispatch',
      );
    }
    await app.start(deps.port);
    logger.info(
      {
        mode: socketMode ? 'socket' : 'http',
        port: deps.port,
        intake: deps.roles.intakeChannelId,
        dispatch: deps.roles.dispatchChannelId,
        hq: deps.roles.hqChannelId,
        judges: deps.roles.judgesChannelId,
      },
      'relay up',
    );
    // Publish the judge on-ramp once the app is up (best-effort — never let a Slack
    // API failure after the server is listening crash the process / fail health checks).
    try {
      await publishJudgeWelcome();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'relay: could not publish judge welcome (non-fatal)');
    }
  };

  return { app, start, refreshHomes };
}

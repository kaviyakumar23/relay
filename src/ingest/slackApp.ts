import { randomUUID } from 'node:crypto';
import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import { needEventKey } from '../ledger/idempotency';
import type { NeedService } from '../ledger/needService';
import type { EventStore } from '../ledger/store/eventStore';
import type { AuditLog } from '../lib/auditLog';
import { logger } from '../lib/logger';
import type { ContactVault } from '../lib/vault';
import type { LlmProvider } from '../llm/provider';
import { matchRationale } from '../match/rationale';
import { type LocalityCoord, type ScoreNeed, topN } from '../match/scorer';
import type { Volunteer, VolunteerStore } from '../match/volunteerStore';
import type { PipelineQueue } from '../pipeline/queue';
import {
  ASSIGN_PICK_ACTION,
  buildMatchBlocks,
  type MatchNeed,
  parseAssignTarget,
  type RankedCandidate,
} from '../surfaces/matchCard';
import { parseMergeTarget } from '../surfaces/needCard';
import { ACTIONS, context, escapeMrkdwn, parseActionId, type SlackView } from '../surfaces/primitives';
import { buildVolunteerModal, parseVolunteerSubmission, VOLUNTEER_CALLBACK_ID } from '../surfaces/volunteerModal';
import type { DedupeStore } from './dedupe';
import { handleIntakeMessage } from './intakeHandler';
import type { Notifier } from './notifier';

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
}

export interface ChannelRoleConfig {
  /** RELAY_INTAKE_CHANNEL override (a channel id). */
  intakeChannelId?: string;
  /** RELAY_DISPATCH_CHANNEL override (a channel id). */
  dispatchChannelId?: string;
  /** Fallback name lookup via conversations.list. */
  intakeChannelName?: string;
  dispatchChannelName?: string;
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
}

const DEFAULT_INTAKE_NAME = 'relay-intake';
const DEFAULT_DISPATCH_NAME = 'relay-dispatch';

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

/** Resolve intake/dispatch channel ids (env override first, then name lookup). */
async function resolveRoles(client: WebClient, roles: MutableRoles, cfg: ChannelRoleConfig): Promise<void> {
  const intakeId = cfg.intakeChannelId;
  const dispatchId = cfg.dispatchChannelId;
  if (intakeId && dispatchId) {
    roles.intakeChannelId = intakeId;
    roles.dispatchChannelId = dispatchId;
    return;
  }
  const byName = await channelsByName(client);
  roles.intakeChannelId = intakeId ?? byName.get(cfg.intakeChannelName ?? DEFAULT_INTAKE_NAME) ?? '';
  roles.dispatchChannelId = dispatchId ?? byName.get(cfg.dispatchChannelName ?? DEFAULT_DISPATCH_NAME) ?? '';
}

/** Safely read an action_id off Bolt's (union-typed) action payload. */
function readActionId(action: unknown): string {
  if (typeof action === 'object' && action !== null && 'action_id' in action) {
    const id = (action as { action_id: unknown }).action_id;
    return typeof id === 'string' ? id : '';
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

export interface BuiltSlackApp {
  app: App;
  start: () => Promise<void>;
}

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
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, service: 'relay' }));
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

  // App Home — the live operations board, scoped to the opener.
  app.event('app_home_opened', async ({ event }) => {
    if (event.tab && event.tab !== 'home') return;
    try {
      const needs = await deps.service.listNeeds();
      await deps.notifier.publishHome(event.user, needs);
    } catch (err) {
      logger.warn({ err, user: event.user }, 'app_home: publish failed');
    }
  });

  // --- Live interaction handlers (Jul 6) --------------------------------------
  // Every consequential transition passes a HUMAN actor (body.user.id) so the engine's
  // gates admit it; ack is immediate and the ledger/card work runs after. Card updates
  // and ephemerals go through the notifier (its own Web client); the modal uses the
  // interaction's own client (views.open needs the request's trigger_id).

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

  // Score the roster for a (now-OPEN) need, emit MatchSuggested, and render the slate
  // under the card. Deterministic scorer; the LLM only phrases each rationale (grounded).
  const runMatch = async (needId: string, ref: ReturnType<typeof readCardRef>): Promise<void> => {
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
    const need = res.need ?? (await deps.service.getNeed(needId));
    if (ref !== null && need !== null) {
      const publicId = await resolvePublicId(needId);
      const otherPublicId = await resolvePublicId(otherNeedId);
      const events = await deps.service.getEvents(needId);
      await deps.notifier.updateCard(ref, { needId, publicId }, need, {
        events,
        publicIdOf: (id) => (id === otherNeedId ? otherPublicId : undefined),
      });
    }
    // Only the clicked (duplicate) card's ref is known here; the original card refreshes
    // on its next natural render. A needId→cardRef index is a documented integrator seam.
  });

  // Assign a picked volunteer (human) → CLAIMED, bump their load, and update the card.
  app.action(new RegExp(`^${ASSIGN_PICK_ACTION}:`), async ({ ack, body, action }) => {
    await ack();
    const { id: packed } = parseActionId(readActionId(action));
    const { needId, volunteerId } = parseAssignTarget(packed);
    const ctx = readBodyContext(body);
    if (!needId || !volunteerId || !ctx.user) return;
    const res = await deps.service.dispatch(
      needId,
      { type: 'Assigned', payload: { volunteer_id: volunteerId, obligation_id: randomUUID(), sla_due_at: null } },
      {
        actor: { type: 'human', id: ctx.user },
        at: new Date().toISOString(),
        idempotencyKey: needEventKey(needId, 'Assigned', interactionId(body, action)),
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
    const need = res.need ?? (await deps.service.getNeed(needId));
    if (ref !== null && need !== null) {
      const publicId = await resolvePublicId(needId);
      const events = await deps.service.getEvents(needId);
      await deps.notifier.updateCard(ref, { needId, publicId }, need, {
        events,
        extraBlocks: [context(`✅ *Assigned to ${escapeMrkdwn(name)}*`)],
      });
    }
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
    await deps.notifier.postEphemeral({
      channel: ctx.channel,
      user: ctx.user,
      text: `🔒 Beneficiary contact: ${contact}\nShared only with you and written to the audit log.`,
    });
    try {
      await deps.auditLog?.record({ actorId: ctx.user, action: 'contact_revealed', subject: needId });
    } catch (err) {
      logger.error({ err, need_id: needId }, 'audit log write failed for contact reveal');
    }
  });

  // /relay volunteer → onboarding modal · /relay volunteers → roster.
  app.command('/relay', async ({ command, ack, respond, client }) => {
    await ack();
    const sub = (command.text ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
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
      } else {
        await respond({
          response_type: 'ephemeral',
          text: 'Usage: `/relay volunteer` to join or update your profile · `/relay volunteers` to see the roster.',
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
      },
      'relay up',
    );
  };

  return { app, start };
}

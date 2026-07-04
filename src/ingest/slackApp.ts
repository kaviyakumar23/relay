import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { NeedService } from '../ledger/needService';
import { logger } from '../lib/logger';
import type { PipelineQueue } from '../pipeline/queue';
import { ACTIONS, parseActionId } from '../surfaces/primitives';
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

  // Day-1 placeholder buttons — Confirm/Assign render but their logic ships with
  // triage (Jul 6). Ack fast, then post a "coming soon" ephemeral. The action_ids
  // route through parseActionId now so the wiring is proven end-to-end.
  const postComingSoon = async (feature: string, body: unknown, action: unknown): Promise<void> => {
    const { id } = parseActionId(readActionId(action));
    const { channel, user } = readBodyContext(body);
    if (!channel || !user) return;
    await deps.notifier.postEphemeral({
      channel,
      user,
      text: `${feature} for that need ships in the triage phase (Jul 6). (need ${id || 'unknown'})`,
    });
  };
  app.action(new RegExp(`^${ACTIONS.confirm}:`), async ({ ack, body, action }) => {
    await ack();
    await postComingSoon('Confirm', body, action);
  });
  app.action(new RegExp(`^${ACTIONS.assign}:`), async ({ ack, body, action }) => {
    await ack();
    await postComingSoon('Assign', body, action);
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

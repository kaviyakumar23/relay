import type { BackupCandidate } from '../drift/prewarm';
import type { NeedEvent } from '../ledger/events';
import type { ProjectedNeed } from '../ledger/types';
import { appHomeView, type HomeViewOptions } from '../surfaces/appHome';
import { dispatchCard } from '../surfaces/needCard';
import type { SlackBlock } from '../surfaces/primitives';

// The output surface (ported from kept's notifier seam). Two implementations:
//  - SlackNotifier  — the real Slack Web API (chat.postMessage/update, views.publish).
//  - RecordingNotifier — records every call for hermetic tests + `npm run demo`.
// Higher layers depend only on the Notifier interface, so the demo and the e2e
// test drive the exact same intake pipeline the live app does, minus Slack.

/** Identity of a need for card rendering (its projection is passed alongside). */
export interface DispatchTarget {
  needId: string;
  publicId: string;
}

/** A posted message reference (channel + ts) for later chat.update calls. */
export interface CardRef {
  channel: string;
  ts: string;
}

/** Optional render inputs threaded to the dispatch card: `events` (duplicate banner),
 * a `publicIdOf` resolver (N-000x labels), and `extraBlocks` appended after the card
 * (e.g. the match slate rendered under a need after triage). */
export interface CardRenderOptions {
  events?: NeedEvent[];
  publicIdOf?: (needId: string) => string | undefined;
  extraBlocks?: SlackBlock[];
  /** A pre-warmed backup volunteer for a live obligation (Moonshot — computeBackup); threaded to
   * the dispatch card so the standby chip renders on a CLAIMED/IN_PROGRESS need. */
  backup?: BackupCandidate | null;
}

/** Compose the dispatch card + any appended blocks from render options. */
function renderCardBlocks(publicId: string, projection: ProjectedNeed, opts?: CardRenderOptions): SlackBlock[] {
  const card = dispatchCard(publicId, projection, {
    events: opts?.events,
    publicIdOf: opts?.publicIdOf,
    backup: opts?.backup,
  });
  return opts?.extraBlocks && opts.extraBlocks.length > 0 ? [...card, ...opts.extraBlocks] : card;
}

export interface Notifier {
  /** Post the dispatch card for a newly-created need to #relay-dispatch. */
  postDispatchCard(need: DispatchTarget, projection: ProjectedNeed, opts?: CardRenderOptions): Promise<CardRef>;
  /** Re-render an existing dispatch card in place (e.g. after triage / match). */
  updateCard(ref: CardRef, need: DispatchTarget, projection: ProjectedNeed, opts?: CardRenderOptions): Promise<void>;
  /** Publish the App Home operations board for a user. `opts` threads the viewer's active
   * filter, the demo SLA multiplier, an as-of clock, and the N-000x label resolver (§F2). */
  publishHome(userId: string, needs: ProjectedNeed[], opts?: HomeViewOptions): Promise<void>;
  /** Ephemeral notice to one user in a channel (e.g. "that button ships in triage"). Optional
   * `blocks` render a framed message (e.g. the contact-reveal card); `text` is the fallback. */
  postEphemeral(args: { channel: string; user: string; text: string; blocks?: SlackBlock[] }): Promise<void>;
  /** DM a user directly (Slack opens the IM by user id). Used for drift nudges. */
  postDirect(userId: string, text: string, blocks: SlackBlock[]): Promise<CardRef>;
  /** Post an arbitrary block message to #relay-dispatch (e.g. a reassignment card). */
  postToDispatch(text: string, blocks: SlackBlock[]): Promise<CardRef>;
  /** Post an arbitrary block message to a specific channel (e.g. a sitrep/report to #relay-hq).
   * `threadTs` threads the message under an existing message (e.g. a requester-facing progress
   * reply posted under the original intake message); omit for a top-level channel post. */
  postToChannel(channel: string, text: string, blocks: SlackBlock[], threadTs?: string): Promise<CardRef>;
  /** Re-render any posted message in place (nudge DM / reassignment card acknowledgement). */
  updateMessage(ref: CardRef, text: string, blocks: SlackBlock[]): Promise<void>;
}

/** Minimal structural view of the Slack Web client methods the notifier uses. */
export interface SlackClientLike {
  chat: {
    postMessage(args: {
      channel: string;
      text: string;
      blocks?: unknown;
      thread_ts?: string;
    }): Promise<{ ts?: string; channel?: string }>;
    update(args: { channel: string; ts: string; text: string; blocks?: unknown }): Promise<unknown>;
    postEphemeral(args: { channel: string; user: string; text: string; blocks?: unknown }): Promise<unknown>;
  };
  views: {
    publish(args: { user_id: string; view: unknown }): Promise<unknown>;
  };
}

/** A one-line fallback text for a card (screen readers / notifications). No message content. */
const cardFallback = (need: DispatchTarget): string => `${need.publicId} · new need in dispatch`;

/**
 * Production notifier on the Slack Web API. The dispatch channel is resolved at
 * boot (env override or name lookup) and read through a thunk so it can be filled
 * after the app client is available.
 */
export class SlackNotifier implements Notifier {
  constructor(
    private readonly client: SlackClientLike,
    private readonly dispatchChannel: () => string,
  ) {}

  async postDispatchCard(need: DispatchTarget, projection: ProjectedNeed, opts?: CardRenderOptions): Promise<CardRef> {
    const channel = this.dispatchChannel();
    const res = await this.client.chat.postMessage({
      channel,
      text: cardFallback(need),
      blocks: renderCardBlocks(need.publicId, projection, opts),
    });
    return { channel: res.channel ?? channel, ts: res.ts ?? '' };
  }

  async updateCard(
    ref: CardRef,
    need: DispatchTarget,
    projection: ProjectedNeed,
    opts?: CardRenderOptions,
  ): Promise<void> {
    await this.client.chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: cardFallback(need),
      blocks: renderCardBlocks(need.publicId, projection, opts),
    });
  }

  async publishHome(userId: string, needs: ProjectedNeed[], opts?: HomeViewOptions): Promise<void> {
    await this.client.views.publish({ user_id: userId, view: appHomeView(needs, opts) });
  }

  async postEphemeral(args: { channel: string; user: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
    await this.client.chat.postEphemeral(args);
  }

  async postDirect(userId: string, text: string, blocks: SlackBlock[]): Promise<CardRef> {
    // Slack opens (or reuses) the IM when chat.postMessage targets a user id.
    const res = await this.client.chat.postMessage({ channel: userId, text, blocks });
    return { channel: res.channel ?? userId, ts: res.ts ?? '' };
  }

  async postToDispatch(text: string, blocks: SlackBlock[]): Promise<CardRef> {
    const channel = this.dispatchChannel();
    const res = await this.client.chat.postMessage({ channel, text, blocks });
    return { channel: res.channel ?? channel, ts: res.ts ?? '' };
  }

  async postToChannel(channel: string, text: string, blocks: SlackBlock[], threadTs?: string): Promise<CardRef> {
    const res = await this.client.chat.postMessage({ channel, text, blocks, thread_ts: threadTs });
    return { channel: res.channel ?? channel, ts: res.ts ?? '' };
  }

  async updateMessage(ref: CardRef, text: string, blocks: SlackBlock[]): Promise<void> {
    await this.client.chat.update({ channel: ref.channel, ts: ref.ts, text, blocks });
  }
}

export interface RecordedCard extends CardRef {
  needId: string;
  publicId: string;
  projection: ProjectedNeed;
  blocks: SlackBlock[];
}

export interface RecordedUpdate {
  ref: CardRef;
  needId: string;
  publicId: string;
  projection: ProjectedNeed;
  blocks: SlackBlock[];
}

export interface RecordedHome {
  userId: string;
  count: number;
  /** The view options the board was published with (active filter etc.), for assertions. */
  opts?: HomeViewOptions;
}

export interface RecordedEphemeral {
  channel: string;
  user: string;
  text: string;
  /** The framed blocks when the ephemeral carries them (e.g. the contact-reveal card). */
  blocks?: SlackBlock[];
}

/** A recorded direct message (drift nudge) — the DM's ref, target user, text + blocks. */
export interface RecordedDm extends CardRef {
  userId: string;
  text: string;
  blocks: SlackBlock[];
}

/** A recorded ad-hoc dispatch post (reassignment card) — its ref, text + blocks. */
export interface RecordedPost extends CardRef {
  text: string;
  blocks: SlackBlock[];
}

/** A recorded post to a named channel (sitrep/report to #relay-hq) — its ref, target channel,
 * text + blocks, and the `threadTs` it was threaded under (e.g. a requester-facing reply posted
 * into the original intake message's thread), when one was supplied. */
export interface RecordedChannelPost extends CardRef {
  text: string;
  blocks: SlackBlock[];
  threadTs?: string;
}

/** A recorded in-place message update (nudge DM / reassignment card acknowledgement). */
export interface RecordedMessageUpdate {
  ref: CardRef;
  text: string;
  blocks: SlackBlock[];
}

/** Records every notification for assertions (no Slack required). */
export class RecordingNotifier implements Notifier {
  readonly cards: RecordedCard[] = [];
  readonly updates: RecordedUpdate[] = [];
  readonly homes: RecordedHome[] = [];
  readonly ephemerals: RecordedEphemeral[] = [];
  readonly dms: RecordedDm[] = [];
  readonly dispatchPosts: RecordedPost[] = [];
  readonly channelPosts: RecordedChannelPost[] = [];
  readonly messageUpdates: RecordedMessageUpdate[] = [];
  private seq = 0;

  async postDispatchCard(need: DispatchTarget, projection: ProjectedNeed, opts?: CardRenderOptions): Promise<CardRef> {
    const ref: CardRef = { channel: 'C_DISPATCH_REC', ts: `ts_${this.seq++}` };
    this.cards.push({
      ...ref,
      needId: need.needId,
      publicId: need.publicId,
      projection,
      blocks: renderCardBlocks(need.publicId, projection, opts),
    });
    return ref;
  }

  async updateCard(
    ref: CardRef,
    need: DispatchTarget,
    projection: ProjectedNeed,
    opts?: CardRenderOptions,
  ): Promise<void> {
    this.updates.push({
      ref,
      needId: need.needId,
      publicId: need.publicId,
      projection,
      blocks: renderCardBlocks(need.publicId, projection, opts),
    });
  }

  async publishHome(userId: string, needs: ProjectedNeed[], opts?: HomeViewOptions): Promise<void> {
    this.homes.push({ userId, count: needs.length, opts });
  }

  async postEphemeral(args: { channel: string; user: string; text: string; blocks?: SlackBlock[] }): Promise<void> {
    this.ephemerals.push({ ...args });
  }

  async postDirect(userId: string, text: string, blocks: SlackBlock[]): Promise<CardRef> {
    const ref: CardRef = { channel: `D_${userId}`, ts: `ts_${this.seq++}` };
    this.dms.push({ ...ref, userId, text, blocks });
    return ref;
  }

  async postToDispatch(text: string, blocks: SlackBlock[]): Promise<CardRef> {
    const ref: CardRef = { channel: 'C_DISPATCH_REC', ts: `ts_${this.seq++}` };
    this.dispatchPosts.push({ ...ref, text, blocks });
    return ref;
  }

  async postToChannel(channel: string, text: string, blocks: SlackBlock[], threadTs?: string): Promise<CardRef> {
    const ref: CardRef = { channel, ts: `ts_${this.seq++}` };
    this.channelPosts.push({ ...ref, text, blocks, threadTs });
    return ref;
  }

  async updateMessage(ref: CardRef, text: string, blocks: SlackBlock[]): Promise<void> {
    this.messageUpdates.push({ ref, text, blocks });
  }

  /** The public ids of every dispatch card posted, in order (for test assertions). */
  publicIds(): string[] {
    return this.cards.map((c) => c.publicId);
  }
}

import type { ProjectedNeed } from '../ledger/types';
import { appHomeView } from '../surfaces/appHome';
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

export interface Notifier {
  /** Post the dispatch card for a newly-created need to #relay-dispatch. */
  postDispatchCard(need: DispatchTarget, projection: ProjectedNeed): Promise<CardRef>;
  /** Re-render an existing dispatch card in place (e.g. after triage). */
  updateCard(ref: CardRef, need: DispatchTarget, projection: ProjectedNeed): Promise<void>;
  /** Publish the App Home operations board for a user. */
  publishHome(userId: string, needs: ProjectedNeed[]): Promise<void>;
  /** Ephemeral notice to one user in a channel (e.g. "that button ships in triage"). */
  postEphemeral(args: { channel: string; user: string; text: string }): Promise<void>;
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
    postEphemeral(args: { channel: string; user: string; text: string }): Promise<unknown>;
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

  async postDispatchCard(need: DispatchTarget, projection: ProjectedNeed): Promise<CardRef> {
    const channel = this.dispatchChannel();
    const res = await this.client.chat.postMessage({
      channel,
      text: cardFallback(need),
      blocks: dispatchCard(need.publicId, projection),
    });
    return { channel: res.channel ?? channel, ts: res.ts ?? '' };
  }

  async updateCard(ref: CardRef, need: DispatchTarget, projection: ProjectedNeed): Promise<void> {
    await this.client.chat.update({
      channel: ref.channel,
      ts: ref.ts,
      text: cardFallback(need),
      blocks: dispatchCard(need.publicId, projection),
    });
  }

  async publishHome(userId: string, needs: ProjectedNeed[]): Promise<void> {
    await this.client.views.publish({ user_id: userId, view: appHomeView(needs) });
  }

  async postEphemeral(args: { channel: string; user: string; text: string }): Promise<void> {
    await this.client.chat.postEphemeral(args);
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
}

export interface RecordedHome {
  userId: string;
  count: number;
}

export interface RecordedEphemeral {
  channel: string;
  user: string;
  text: string;
}

/** Records every notification for assertions (no Slack required). */
export class RecordingNotifier implements Notifier {
  readonly cards: RecordedCard[] = [];
  readonly updates: RecordedUpdate[] = [];
  readonly homes: RecordedHome[] = [];
  readonly ephemerals: RecordedEphemeral[] = [];
  private seq = 0;

  async postDispatchCard(need: DispatchTarget, projection: ProjectedNeed): Promise<CardRef> {
    const ref: CardRef = { channel: 'C_DISPATCH_REC', ts: `ts_${this.seq++}` };
    this.cards.push({
      ...ref,
      needId: need.needId,
      publicId: need.publicId,
      projection,
      blocks: dispatchCard(need.publicId, projection),
    });
    return ref;
  }

  async updateCard(ref: CardRef, need: DispatchTarget, projection: ProjectedNeed): Promise<void> {
    this.updates.push({ ref, needId: need.needId, publicId: need.publicId, projection });
  }

  async publishHome(userId: string, needs: ProjectedNeed[]): Promise<void> {
    this.homes.push({ userId, count: needs.length });
  }

  async postEphemeral(args: { channel: string; user: string; text: string }): Promise<void> {
    this.ephemerals.push({ ...args });
  }

  /** The public ids of every dispatch card posted, in order (for test assertions). */
  publicIds(): string[] {
    return this.cards.map((c) => c.publicId);
  }
}

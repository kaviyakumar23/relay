import { logger } from '../lib/logger';

// Zero-copy text reconstitution seam (BUILD-DOC §9.1, CLAUDE.md invariant #5). The
// durable PipelineJob carries only Slack object references (team/channel/ts) — NEVER
// the raw message text. Under the InlineQueue the text flows through memory alongside
// the job (JobTransient); under BullMQ the durable job crosses the Redis boundary,
// where the transient is intentionally dropped, so a distributed worker must RE-FETCH
// the single message text from Slack at processing time. `TextFetcher` is that seam —
// injected into BullMQQueue so the durable path produces the SAME extraction as inline.
//
// PII / zero-copy discipline (invariant #5): the fetched text is handed straight to the
// extraction step in memory and is NEVER persisted (Redis, ledger rows) and NEVER logged
// — not even in an error line. This module logs only derived signals (channel/ts refs).

/**
 * Fetch a single Slack message's text by (channel, ts). Returns `undefined` when the
 * message cannot be read (deleted, out of history, or an API error) so the caller posts
 * the pre-extraction card rather than losing the need. The text is for in-memory
 * extraction only — implementations must never persist or log it.
 */
export interface TextFetcher {
  fetchText(channelId: string, ts: string): Promise<string | undefined>;
}

/** One message as returned by conversations.history/replies (only the fields we read). */
interface ConversationMessage {
  ts?: string;
  text?: string;
}

interface ConversationResponse {
  messages?: ConversationMessage[];
}

/**
 * Minimal structural view of the Slack Web client methods SlackTextFetcher uses — only
 * conversations.history/replies. Modeled structurally (like notifier's SlackClientLike)
 * so a real `WebClient` satisfies it without the bundled @slack/web-api types leaking
 * into this seam, and tests can pass a plain object with zero env.
 */
export interface SlackConversationsClient {
  conversations: {
    history(args: {
      channel: string;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
      limit?: number;
    }): Promise<ConversationResponse>;
    replies(args: {
      channel: string;
      ts: string;
      latest?: string;
      oldest?: string;
      inclusive?: boolean;
      limit?: number;
    }): Promise<ConversationResponse>;
  };
}

/**
 * Live fetcher over the Slack Web API. Reads exactly ONE message with a 1-wide inclusive
 * window `[ts, ts]` via conversations.history; if that misses (the ts is a threaded
 * reply, which history does not surface) it falls back to conversations.replies, which
 * reads within the thread. Any API failure degrades to `undefined` — a fetch error must
 * never throw out of the worker and lose the need. Never logs the message text.
 */
export class SlackTextFetcher implements TextFetcher {
  constructor(private readonly client: SlackConversationsClient) {}

  async fetchText(channelId: string, ts: string): Promise<string | undefined> {
    const fromHistory = await this.readOne(
      () =>
        this.client.conversations.history({ channel: channelId, latest: ts, oldest: ts, inclusive: true, limit: 1 }),
      channelId,
      ts,
    );
    if (fromHistory !== undefined) return fromHistory;
    // Fallback: a threaded reply is not returned by history — read it inside its thread.
    return this.readOne(
      () =>
        this.client.conversations.replies({
          channel: channelId,
          ts,
          latest: ts,
          oldest: ts,
          inclusive: true,
          limit: 1,
        }),
      channelId,
      ts,
    );
  }

  private async readOne(
    call: () => Promise<ConversationResponse>,
    channelId: string,
    ts: string,
  ): Promise<string | undefined> {
    try {
      const res = await call();
      const messages = res.messages ?? [];
      // Prefer the exact ts (a 1-wide window returns just it, but guard a wider result).
      const message = messages.find((m) => m.ts === ts) ?? messages[0];
      const text = message?.text;
      return text !== undefined && text !== '' ? text : undefined;
    } catch (err) {
      // Zero-copy: log the reference + error only — NEVER the message text (a failed read
      // has no text anyway, but this stays true if the shape ever changes). The caller
      // degrades to the pre-extraction card so the need is not lost.
      logger.debug({ err, channel: channelId, ts }, 'textFetcher: could not fetch message text (non-fatal)');
      return undefined;
    }
  }
}

/**
 * Test double: a scripted `ts → text` map with zero I/O and zero env. Also records every
 * lookup so a test can assert the worker reconstituted text for the right (channel, ts) —
 * i.e. that the BullMQ path fetches before extraction. Mirrors MemoryDedupeStore /
 * RecordingNotifier as the hermetic sibling of the live implementation.
 */
export class StubTextFetcher implements TextFetcher {
  readonly lookups: Array<{ channelId: string; ts: string }> = [];

  constructor(private readonly byTs: Map<string, string>) {}

  async fetchText(channelId: string, ts: string): Promise<string | undefined> {
    this.lookups.push({ channelId, ts });
    return this.byTs.get(ts);
  }
}

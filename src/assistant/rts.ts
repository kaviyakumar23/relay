import { logger } from '../lib/logger';

// Real-Time Search (RTS) client — targeted organizational-reference resolution.
//
// Ported from ../inview/slack-data/rts.js into Relay's TS-strict style, and HARDENED
// with the two gaps inview left open (see CLAUDE.md "Reuse provenance"):
//   1. a min-interval throttle that caps calls at ~10 req/min/user (the RTS soft limit,
//      per ../inview/docs/DECISIONS.md), and
//   2. one retry on a transient failure (network / rate-limit blip), with a short backoff.
//
// Wraps Slack's `assistant.search.context`: we send ONLY targeted queries (the specific
// references the ledger can't explain — never a whole thread) and attach the returned
// `permalink` as the citation. `assistant.search.info` is the pre-flight for semantic
// (Slack AI Search) availability; keyword results work on a plain sandbox.
//
// ZERO-PERSISTENCE (CLAUDE.md invariant 9 / RTS ToS): retrieved content is returned to the
// caller for ephemeral, in-interaction use only. This module never writes it to disk, a DB,
// or a cache, and never logs message content — only derived counts. The caller must not
// store or copy it, nor use it for training.
//
// Token model (DECISIONS.md): a user token (xoxp-) needs no action_token; a bot token
// requires an action_token harvested from a message/app_mention event. We call via
// `client.apiCall(...)` so this works regardless of whether the installed WebClient's typed
// surface exposes the method yet.

/** One resolved reference. `snippet` is a short, ephemeral excerpt for the prompt only. */
export interface Citation {
  query: string;
  found: boolean;
  snippet: string;
  permalink: string | null;
  sourceLabel: string | null;
  channelName: string | null;
}

/** A targeted thing to look up — the specific reference the ledger cannot explain. */
export interface RtsReference {
  rtsQuery: string;
}

/** Optional context to bias ranking toward the current channel. */
export interface RtsContext {
  channelId?: string | null;
}

/** The seam Ask-Relay depends on — satisfied by both RtsClient and the deterministic mock. */
export interface RtsResolver {
  resolveReference(ref: RtsReference, ctx?: RtsContext): Promise<Citation>;
  resolveReferences(refs: RtsReference[], ctx?: RtsContext): Promise<Citation[]>;
  isAiSearchEnabled(): Promise<boolean>;
}

/** The narrow slice of a Slack WebClient we use (structural, so `app.client` satisfies it). */
export interface SlackApiClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface RtsClientOptions {
  client: SlackApiClient;
  /** User token (xoxp-) — the cleaner path; needs no action_token. */
  userToken?: string;
  /** Required only for bot-token calls (harvested from a message/app_mention event). */
  actionToken?: string;
  disableSemanticSearch?: boolean;
  limitPerQuery?: number;
  /** Min ms between RTS calls. Default 6000 ⇒ ≤10 req/min/user (RTS soft cap). */
  minIntervalMs?: number;
  /** Extra attempts after the first on a transient failure. Default 1. */
  maxRetries?: number;
  /** Backoff before a retry. Default 500ms. */
  backoffMs?: number;
  /** Injectable clock/sleep so the throttle + backoff are hermetically testable. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_MIN_INTERVAL_MS = 6_000; // 60_000 / 10 ⇒ ~10 requests per minute per user.
const SNIPPET_MAX = 280;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

const asString = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

function truncate(s: string, n: number): string {
  if (s.length === 0) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

const notFound = (query: string): Citation => ({
  query,
  found: false,
  snippet: '',
  permalink: null,
  sourceLabel: null,
  channelName: null,
});

/**
 * A min-interval reservation throttle. `schedule` synchronously reserves the next slot
 * (advancing `next` before awaiting), so even a burst dispatched via Promise.all is spaced
 * to at most one call per `minIntervalMs`. It caps rate; it does not serialize execution.
 */
class MinIntervalThrottle {
  private next = 0;
  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.now();
    const startAt = Math.max(current, this.next);
    this.next = startAt + this.minIntervalMs;
    const wait = startAt - current;
    if (wait > 0) await this.sleep(wait);
    return fn();
  }
}

export class RtsClient implements RtsResolver {
  private readonly client: SlackApiClient;
  private readonly userToken?: string;
  private readonly actionToken?: string;
  private readonly disableSemanticSearch: boolean;
  private readonly limitPerQuery: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throttle: MinIntervalThrottle;

  constructor(opts: RtsClientOptions) {
    if (!opts.client) throw new Error('RtsClient requires a Slack client');
    this.client = opts.client;
    this.userToken = opts.userToken;
    this.actionToken = opts.actionToken;
    this.disableSemanticSearch = opts.disableSemanticSearch ?? false;
    this.limitPerQuery = opts.limitPerQuery ?? 3;
    this.maxRetries = opts.maxRetries ?? 1;
    this.backoffMs = opts.backoffMs ?? 500;
    this.sleep = opts.sleep ?? defaultSleep;
    this.throttle = new MinIntervalThrottle(
      opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      opts.now ?? Date.now,
      this.sleep,
    );
  }

  /** One API call, throttled, with one retry on a transient failure. */
  private async call(method: string, args: Record<string, unknown>): Promise<unknown> {
    return this.throttle.schedule(async () => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        try {
          return await this.client.apiCall(method, args);
        } catch (err) {
          lastErr = err;
          if (attempt < this.maxRetries) {
            // Derived fields only — never the query text or any retrieved content.
            logger.warn({ method, attempt }, 'rts call failed; retrying after backoff');
            await this.sleep(this.backoffMs);
          }
        }
      }
      throw lastErr;
    });
  }

  /** Resolve a single reference via a targeted RTS query. */
  async resolveReference(ref: RtsReference, ctx: RtsContext = {}): Promise<Citation> {
    const args: Record<string, unknown> = {
      query: ref.rtsQuery,
      content_types: ['messages'],
      limit: this.limitPerQuery,
      include_context_messages: false,
    };
    if (this.userToken) args.token = this.userToken;
    if (this.actionToken) args.action_token = this.actionToken;
    if (this.disableSemanticSearch) args.disable_semantic_search = true;
    if (ctx.channelId) args.context_channel_id = ctx.channelId;

    const res = asRecord(await this.call('assistant.search.context', args));
    const results = asRecord(res.results);
    const messages = Array.isArray(results.messages) ? results.messages : [];
    if (messages.length === 0) return notFound(ref.rtsQuery);

    const msg = asRecord(messages[0]);
    const channelName = asString(msg.channel_name);
    const author = asString(msg.author_name);
    return {
      query: ref.rtsQuery,
      found: true,
      snippet: truncate(asString(msg.content) ?? '', SNIPPET_MAX),
      permalink: asString(msg.permalink),
      sourceLabel: `#${channelName ?? 'unknown'} · ${author ?? 'someone'}`,
      channelName,
    };
  }

  /** Resolve many references. Each is spaced by the throttle even under Promise.all. */
  async resolveReferences(refs: RtsReference[], ctx: RtsContext = {}): Promise<Citation[]> {
    return Promise.all(refs.map((r) => this.resolveReference(r, ctx)));
  }

  /** Pre-flight: is semantic (Slack AI) search available on this workspace? */
  async isAiSearchEnabled(): Promise<boolean> {
    const args: Record<string, unknown> = this.userToken ? { token: this.userToken } : {};
    const res = asRecord(await this.call('assistant.search.info', args));
    return res.is_ai_search_enabled === true;
  }
}

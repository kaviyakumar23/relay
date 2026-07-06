import type { Citation, RtsContext, RtsReference, RtsResolver } from './rts';

// Offline RTS mock — same RtsResolver shape as RtsClient, backed by a static lookup.
// Ported from ../inview/slack-data/rts-mock.js. Deterministic, network-free, and
// zero-env: it is what hermetic tests and `npm run demo` use, and what live mode falls
// back to when no user token (xoxp-) is configured. Like the real keyword-only sandbox
// path, `isAiSearchEnabled` reports false.

/** A lookup value: a Citation minus the fields the mock fills in (query/found default true). */
export interface MockCitation {
  snippet: string;
  permalink: string | null;
  found?: boolean;
  sourceLabel?: string | null;
  channelName?: string | null;
}

/** Either a map of rtsQuery → MockCitation, or a function ref → MockCitation | undefined. */
export type MockLookup = Record<string, MockCitation> | ((ref: RtsReference) => MockCitation | undefined);

const notFound = (query: string): Citation => ({
  query,
  found: false,
  snippet: '',
  permalink: null,
  sourceLabel: null,
  channelName: null,
});

/** Build a deterministic RtsResolver from a static lookup (map or function). */
export function createMockRts(lookup: MockLookup): RtsResolver {
  const resolveReference = async (ref: RtsReference, _ctx?: RtsContext): Promise<Citation> => {
    const hit = typeof lookup === 'function' ? lookup(ref) : lookup[ref.rtsQuery];
    if (!hit) return notFound(ref.rtsQuery);
    return {
      query: ref.rtsQuery,
      found: hit.found ?? true,
      snippet: hit.snippet,
      permalink: hit.permalink,
      sourceLabel: hit.sourceLabel ?? null,
      channelName: hit.channelName ?? null,
    };
  };

  return {
    resolveReference,
    resolveReferences: async (refs, ctx) => Promise.all(refs.map((r) => resolveReference(r, ctx))),
    isAiSearchEnabled: async () => false,
  };
}

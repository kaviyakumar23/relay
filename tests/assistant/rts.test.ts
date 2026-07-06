import { describe, expect, it } from 'vitest';
import { RtsClient, type SlackApiClient } from '../../src/assistant/rts';

// Unit coverage for the ported RtsClient + the hardening inview lacked (throttle + retry).
// Everything is hermetic: a fake apiCall stands in for Slack, and clock/sleep are injected.

interface Call {
  method: string;
  args: Record<string, unknown>;
}

/** A fake Slack client that records calls and returns a scripted sequence of responses. */
function fakeClient(responses: Array<unknown | (() => unknown)>): { client: SlackApiClient; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const client: SlackApiClient = {
    apiCall: async (method, args) => {
      calls.push({ method, args });
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (typeof next === 'function') return (next as () => unknown)();
      return next;
    },
  };
  return { client, calls };
}

const MESSAGE_RESULT = {
  results: {
    messages: [
      {
        content: 'The Velachery community relief shelter is open and has capacity for 40 more people.',
        permalink: 'https://slack.example/archives/C123/p1720051200000100',
        channel_name: 'field-reports',
        author_name: 'coordinator-anitha',
      },
    ],
  },
};

const noop = async (): Promise<void> => {};

describe('RtsClient — port + hardening', () => {
  it('maps a message result to a Citation and sends the user token + targeted args', async () => {
    const { client, calls } = fakeClient([MESSAGE_RESULT]);
    const rts = new RtsClient({ client, userToken: 'xoxp-user', minIntervalMs: 0, sleep: noop });

    const cit = await rts.resolveReference({ rtsQuery: 'Velachery shelter status' }, { channelId: 'C999' });

    expect(cit.found).toBe(true);
    expect(cit.permalink).toBe('https://slack.example/archives/C123/p1720051200000100');
    expect(cit.channelName).toBe('field-reports');
    expect(cit.sourceLabel).toBe('#field-reports · coordinator-anitha');
    expect(cit.snippet).toContain('community relief shelter is open');

    const [call] = calls;
    expect(call?.method).toBe('assistant.search.context');
    expect(call?.args.query).toBe('Velachery shelter status');
    expect(call?.args.token).toBe('xoxp-user');
    expect(call?.args.content_types).toEqual(['messages']);
    expect(call?.args.context_channel_id).toBe('C999');
    expect(call?.args.limit).toBe(3);
  });

  it('returns a not-found citation when there are no messages', async () => {
    const { client } = fakeClient([{ results: { messages: [] } }]);
    const rts = new RtsClient({ client, minIntervalMs: 0, sleep: noop });
    const cit = await rts.resolveReference({ rtsQuery: 'nothing here' });
    expect(cit).toEqual({
      query: 'nothing here',
      found: false,
      snippet: '',
      permalink: null,
      sourceLabel: null,
      channelName: null,
    });
  });

  it('resolves many references in one call', async () => {
    const { client, calls } = fakeClient([MESSAGE_RESULT]);
    const rts = new RtsClient({ client, minIntervalMs: 0, sleep: noop });
    const cits = await rts.resolveReferences([{ rtsQuery: 'a' }, { rtsQuery: 'b' }]);
    expect(cits).toHaveLength(2);
    expect(cits.every((c) => c.found)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('isAiSearchEnabled reads the pre-flight flag', async () => {
    const { client, calls } = fakeClient([{ is_ai_search_enabled: true }]);
    const rts = new RtsClient({ client, userToken: 'xoxp-user', minIntervalMs: 0, sleep: noop });
    expect(await rts.isAiSearchEnabled()).toBe(true);
    expect(calls[0]?.method).toBe('assistant.search.info');
    expect(calls[0]?.args.token).toBe('xoxp-user');
  });

  it('throttles to the min interval — sequential calls are spaced (≈10 req/min at 6s)', async () => {
    const { client } = fakeClient([{ results: { messages: [] } }]);
    const waited: number[] = [];
    const rts = new RtsClient({
      client,
      minIntervalMs: 6_000,
      maxRetries: 0,
      now: () => 1_000, // frozen clock: reservations stack at +6s each
      sleep: async (ms) => {
        waited.push(ms);
      },
    });

    await rts.resolveReference({ rtsQuery: '1' });
    await rts.resolveReference({ rtsQuery: '2' });
    await rts.resolveReference({ rtsQuery: '3' });

    // First call runs immediately (no wait); the next two are pushed out by one interval each.
    expect(waited).toEqual([6_000, 12_000]);
  });

  it('retries once on a transient failure, then succeeds', async () => {
    let first = true;
    const { client, calls } = fakeClient([
      () => {
        if (first) {
          first = false;
          throw new Error('ECONNRESET');
        }
        return MESSAGE_RESULT;
      },
    ]);
    const backoffs: number[] = [];
    const rts = new RtsClient({
      client,
      minIntervalMs: 0,
      maxRetries: 1,
      backoffMs: 250,
      sleep: async (ms) => {
        backoffs.push(ms);
      },
    });

    const cit = await rts.resolveReference({ rtsQuery: 'flaky' });
    expect(cit.found).toBe(true);
    expect(calls).toHaveLength(2); // initial + one retry
    expect(backoffs).toEqual([250]);
  });

  it('rethrows after exhausting retries', async () => {
    const { client } = fakeClient([
      () => {
        throw new Error('rate_limited');
      },
    ]);
    const rts = new RtsClient({ client, minIntervalMs: 0, maxRetries: 1, backoffMs: 0, sleep: noop });
    await expect(rts.resolveReference({ rtsQuery: 'always fails' })).rejects.toThrow('rate_limited');
  });
});

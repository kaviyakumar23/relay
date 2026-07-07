import { describe, expect, it } from 'vitest';
import { RecordingNotifier } from '../../src/ingest/notifier';
import { NeedService } from '../../src/ledger/needService';
import { InMemoryEventStore } from '../../src/ledger/store/memoryStore';
import { HeuristicExtractor } from '../../src/pipeline/extract';
import { makeIntakeJobHandler } from '../../src/pipeline/intakeJob';
import { type IntakeJob, processIntakeJob } from '../../src/pipeline/queue';
import { type SlackConversationsClient, SlackTextFetcher, StubTextFetcher } from '../../src/pipeline/textFetcher';

// processIntakeJob is the shared per-job step BullMQ's worker runs. Its whole reason to
// exist is that the durable (Redis) path must produce the SAME extraction as InlineQueue:
// it reconstitutes the raw text via an injected TextFetcher before calling the handler.
// These lock that — proving the BullMQ path TRIAGES (not stuck NEW), which the confirmed
// bug (dropped transient → extraction never ran) left broken under Redis.

const TEAM = 'T_TEST';
const CHANNEL = 'C_INTAKE';
const BASE = Date.parse('2026-07-04T00:00:00.000Z');

function buildPipeline() {
  const store = new InMemoryEventStore();
  const service = new NeedService(store, () => BASE);
  const notifier = new RecordingNotifier();
  const handler = makeIntakeJobHandler({ service, notifier, extractor: new HeuristicExtractor(), now: () => BASE });
  return { store, service, notifier, handler };
}

function intakeJob(messageTs: string): IntakeJob {
  return { kind: 'intake', teamId: TEAM, channelId: CHANNEL, messageTs, userId: 'U_REPORTER' };
}

describe('processIntakeJob — the BullMQ worker step reconstitutes text and triages', () => {
  it('fetches text via the TextFetcher and drives extraction → TRIAGED (not stuck NEW)', async () => {
    const { service, notifier, handler } = buildPipeline();
    const ts = '1720051200.000111';
    const fetcher = new StubTextFetcher(new Map([[ts, 'Family trapped on the terrace in Velachery, 3 people']]));

    await processIntakeJob(intakeJob(ts), { handler, textFetcher: fetcher });

    // The worker asked the fetcher for exactly this (channel, ts) — proof it reconstituted
    // the transient text before the handler (the step the dropped-sidecar bug skipped).
    expect(fetcher.lookups).toEqual([{ channelId: CHANNEL, ts }]);

    const needs = await service.listNeeds();
    expect(needs).toHaveLength(1);
    const need = needs[0];
    if (!need) throw new Error('no need');
    // Extraction ran: the need advanced past NEW to TRIAGED — the Confirm button is now
    // legal (TriageConfirmed applies from TRIAGED/NEEDS_REVIEW), which under the bug it wasn't.
    expect(need.state).toBe('TRIAGED');
    expect(need.severity).toBe('critical'); // 'trapped' floor
    expect(notifier.cards).toHaveLength(1);
    expect(notifier.cards[0]?.projection.state).toBe('TRIAGED');
  });

  it('routes a garbled fetched message to NEEDS_REVIEW (full extraction ran on fetched text)', async () => {
    const { service, handler } = buildPipeline();
    const ts = '1720051200.000222';
    const fetcher = new StubTextFetcher(
      new Map([[ts, 'pls help wtr coming in fast nr the ... signal weak cant type childr']]),
    );

    await processIntakeJob(intakeJob(ts), { handler, textFetcher: fetcher });

    const need = (await service.listNeeds())[0];
    if (!need) throw new Error('no need');
    expect(need.state).toBe('NEEDS_REVIEW'); // no type/location/headcount → needs_review
    expect(need.severity).toBe('critical'); // 'child' floor still fires on the raw text
  });

  it('with NO fetcher: still creates the need + posts a card, but stays NEW (extraction skipped)', async () => {
    const { service, notifier, handler } = buildPipeline();
    const ts = '1720051200.000333';

    await processIntakeJob(intakeJob(ts), { handler });

    const need = (await service.listNeeds())[0];
    if (!need) throw new Error('no need');
    expect(need.state).toBe('NEW'); // no text → pre-extraction card, need NOT lost
    expect(notifier.cards).toHaveLength(1);
  });

  it('a deleted/unreadable message (fetcher → undefined): need created + card posted, not lost', async () => {
    const { service, notifier, handler } = buildPipeline();
    const ts = '1720051200.000444';
    const fetcher = new StubTextFetcher(new Map()); // no entry → undefined

    await processIntakeJob(intakeJob(ts), { handler, textFetcher: fetcher });

    const need = (await service.listNeeds())[0];
    if (!need) throw new Error('no need');
    expect(need.state).toBe('NEW');
    expect(notifier.cards).toHaveLength(1);
  });
});

// A conversations client that records its calls and replays scripted responses.
function fakeClient(script: {
  history?: (args: { channel: string; latest?: string; oldest?: string; inclusive?: boolean; limit?: number }) => {
    messages?: Array<{ ts?: string; text?: string }>;
  };
  replies?: (args: { channel: string; ts: string }) => { messages?: Array<{ ts?: string; text?: string }> };
}): { client: SlackConversationsClient; historyArgs: unknown[]; repliesArgs: unknown[] } {
  const historyArgs: unknown[] = [];
  const repliesArgs: unknown[] = [];
  const client: SlackConversationsClient = {
    conversations: {
      history: async (args) => {
        historyArgs.push(args);
        if (!script.history) throw new Error('no history scripted');
        return script.history(args);
      },
      replies: async (args) => {
        repliesArgs.push(args);
        if (!script.replies) throw new Error('no replies scripted');
        return script.replies(args);
      },
    },
  };
  return { client, historyArgs, repliesArgs };
}

describe('SlackTextFetcher — one-message read, thread fallback, degrade-not-throw', () => {
  it('reads the single message via conversations.history with a 1-wide inclusive window', async () => {
    const ts = '1720051200.000111';
    const { client, historyArgs } = fakeClient({ history: () => ({ messages: [{ ts, text: 'help in Velachery' }] }) });

    const text = await new SlackTextFetcher(client).fetchText('C1', ts);

    expect(text).toBe('help in Velachery');
    expect(historyArgs).toEqual([{ channel: 'C1', latest: ts, oldest: ts, inclusive: true, limit: 1 }]);
  });

  it('falls back to conversations.replies when history returns nothing (threaded reply)', async () => {
    const ts = '1720051200.000222';
    const { client, repliesArgs } = fakeClient({
      history: () => ({ messages: [] }),
      replies: () => ({ messages: [{ ts, text: 'reply text' }] }),
    });

    const text = await new SlackTextFetcher(client).fetchText('C2', ts);

    expect(text).toBe('reply text');
    expect(repliesArgs).toEqual([{ channel: 'C2', ts, latest: ts, oldest: ts, inclusive: true, limit: 1 }]);
  });

  it('an API error degrades to undefined (never throws out of the worker)', async () => {
    const { client } = fakeClient({
      history: () => {
        throw new Error('rate_limited');
      },
      replies: () => {
        throw new Error('rate_limited');
      },
    });

    await expect(new SlackTextFetcher(client).fetchText('C3', '1.1')).resolves.toBeUndefined();
  });

  it('an empty message text is treated as no text (undefined)', async () => {
    const ts = '1720051200.000333';
    const { client } = fakeClient({
      history: () => ({ messages: [{ ts, text: '' }] }),
      replies: () => ({ messages: [] }),
    });

    await expect(new SlackTextFetcher(client).fetchText('C4', ts)).resolves.toBeUndefined();
  });
});

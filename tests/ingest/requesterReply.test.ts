import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { RecordingNotifier } from '../../src/ingest/notifier';
import { postRequesterReply } from '../../src/ingest/requesterReply';

// Moonshot #4 — the integrator seam that posts a language-matched progress reply into the
// REQUESTER's own source thread. These pin the wiring the pure builder can't: the reply is
// threaded under need.source.ts in need.source.channel, is text-only, and is best-effort —
// a missing source thread returns false and posts nothing (never throws, never a transition).

/** Any character in the Tamil Unicode block (U+0B80–U+0BFF). */
const TAMIL = /[஀-௿]/;

/** A real ta (Tamil code-mix) need off the hermetic pipeline, so its source + languages are honest. */
async function taNeed() {
  const a = buildHermeticAssembly();
  await injectIntake(a, {
    eventId: 'ev-req-1',
    messageTs: '1720051200.000001',
    userId: 'U_REQUESTER',
    text: 'Velachery la moonu families terrace mela maatikittu irukanga, chinna kuzhandhaigal, food and water urgent-a venum.',
  });
  const needs = await a.service.listNeeds();
  const need = needs[0];
  if (need === undefined) throw new Error('expected one need');
  return need;
}

describe('postRequesterReply — threads into the requester source', () => {
  it('posts a bilingual reply into need.source.channel under source.ts for a ta need', async () => {
    const need = await taNeed();
    expect(need.languages).toContain('ta');
    const notifier = new RecordingNotifier();

    const posted = await postRequesterReply({
      notifier,
      need,
      kind: 'assigned',
      volunteerName: 'Anitha Kumar',
      publicId: 'N-0001',
    });

    expect(posted).toBe(true);
    expect(notifier.channelPosts).toHaveLength(1);
    const post = notifier.channelPosts[0];
    expect(post?.channel).toBe(need.source.channel);
    expect(post?.threadTs).toBe(need.source.ts); // threaded under the ORIGINAL message
    expect(TAMIL.test(post?.text ?? '')).toBe(true); // bilingual: Tamil present
    expect(/[A-Za-z]/.test(post?.text ?? '')).toBe(true); // and English
    expect(post?.text).toContain('N-0001');
    expect(post?.text).toContain('Anitha'); // first name only
    expect(post?.text).not.toContain('Kumar'); // never the surname (PII discipline)
    expect(post?.blocks).toEqual([]); // text-only reply
  });

  it('renders English-only (no Tamil) for an en need', async () => {
    const base = await taNeed();
    const need = { ...base, languages: ['en'] };
    const notifier = new RecordingNotifier();

    await postRequesterReply({ notifier, need, kind: 'verified', publicId: 'N-0009' });

    const post = notifier.channelPosts[0];
    expect(TAMIL.test(post?.text ?? '')).toBe(false);
    expect(post?.text).toContain('N-0009');
  });

  it('is best-effort: returns false and posts nothing when the source thread is missing', async () => {
    const base = await taNeed();
    const notifier = new RecordingNotifier();

    const missingSources = [
      { ...base.source, ts: undefined },
      { ...base.source, channel: undefined },
      { ...base.source, channel: '', ts: '' },
      {},
    ];
    for (const source of missingSources) {
      const posted = await postRequesterReply({
        notifier,
        need: { ...base, source },
        kind: 'assigned',
        publicId: 'N-1',
      });
      expect(posted).toBe(false);
    }
    expect(notifier.channelPosts).toHaveLength(0); // never posts without a real thread
  });
});

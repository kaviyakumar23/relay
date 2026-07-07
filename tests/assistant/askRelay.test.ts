import { describe, expect, it } from 'vitest';
import { askRelay } from '../../src/assistant/askRelay';
import { createMockRts } from '../../src/assistant/rtsMock';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { MockLlm } from '../../src/llm/mock';
import { computeSitrepStats } from '../../src/narrate/aggregate';
import { assertNoPii } from '../../src/narrate/redaction';

// Hermetic coverage for the Ask-Relay brain (F8). Real ledger data via the hermetic assembly;
// MockLlm through the same Zod boundary the real providers use; a deterministic rtsMock.

const EVENTS = [
  {
    eventId: 'Ev1',
    messageTs: '1720051200.000111',
    userId: 'U1',
    text: 'Terrace flooded in Velachery, food needed',
    permalink: 'https://relay.demo/p1',
  },
  {
    eventId: 'Ev2',
    messageTs: '1720051201.000222',
    userId: 'U2',
    text: 'Dialysis patient stuck near Taramani',
    permalink: 'https://relay.demo/p2',
  },
  {
    eventId: 'Ev3',
    messageTs: '1720051202.000333',
    userId: 'U3',
    text: 'Family trapped on first floor in Pallikaranai',
    permalink: 'https://relay.demo/p3',
  },
];

const NOW = Date.parse('2026-07-04T02:00:00.000Z');

async function seed() {
  const a = buildHermeticAssembly();
  for (const e of EVENTS) await injectIntake(a, e);
  return a;
}

/** No 10-digit (Indian-mobile shaped) run should ever appear in an answer. */
const hasContactDigits = (s: string): boolean => /(?<!\d)[6-9]\d{4}[\s.-]?\d{5}(?!\d)/.test(s) || /\d{10}/.test(s);

describe('askRelay — F8 assistant brain', () => {
  it('no llm ⇒ deterministic template that lists the open criticals, grounded and PII-free', async () => {
    const a = await seed();
    const openCritical = computeSitrepStats(await a.service.listNeeds(NOW), NOW).openCritical;
    expect(openCritical).toBe(2); // dialysis + trapped, both floored to critical

    const res = await askRelay({ question: 'any critical needs still open?', service: a.service, now: NOW });

    expect(res.intent).toBe('open-criticals');
    expect(res.source).toBe('template');
    expect(res.usedRts).toBe(false);
    expect(res.answer).toContain(String(openCritical));
    expect(assertNoPii(res.answer).ok).toBe(true);
    expect(hasContactDigits(res.answer)).toBe(false);
  });

  it('with an llm ⇒ synthesised answer is used when its numbers are grounded and its citation is real', async () => {
    const a = await seed();
    const llm = new MockLlm(() => ({
      answer: '2 critical needs are still open — a medical need in Taramani and a rescue need in Pallikaranai.',
      citations: [{ label: 'field', permalink: 'https://relay.demo/p2' }],
      out_of_scope: false,
    }));

    const res = await askRelay({ question: 'any critical needs still open?', service: a.service, llm, now: NOW });

    expect(res.source).toBe('llm');
    expect(res.intent).toBe('open-criticals');
    expect(res.answer).toContain('Taramani');
    // The cited permalink is one we actually provided (a selected critical need) ⇒ it survives.
    expect(res.citations.some((c) => c.permalink === 'https://relay.demo/p2')).toBe(true);
    expect(assertNoPii(res.answer).ok).toBe(true);
  });

  it('a hallucinated number in the llm answer ⇒ falls back to the deterministic template', async () => {
    const a = await seed();
    const llm = new MockLlm(() => ({
      answer: 'A staggering 9999 critical needs are open across the city.',
      citations: [],
      out_of_scope: false,
    }));

    const res = await askRelay({ question: 'any critical needs still open?', service: a.service, llm, now: NOW });

    expect(res.source).toBe('template');
    expect(res.answer).not.toContain('9999');
  });

  it('an llm-invented permalink is stripped from the citations', async () => {
    const a = await seed();
    const llm = new MockLlm(() => ({
      answer: 'Two critical needs remain open.',
      citations: [{ label: 'fabricated', permalink: 'https://evil.example/not-a-real-source' }],
      out_of_scope: false,
    }));

    const res = await askRelay({ question: 'any critical needs still open?', service: a.service, llm, now: NOW });

    expect(res.source).toBe('llm');
    expect(res.citations.every((c) => c.permalink !== 'https://evil.example/not-a-real-source')).toBe(true);
    // The label is kept even though the invented link was dropped.
    expect(res.citations.some((c) => c.label === 'fabricated' && c.permalink === undefined)).toBe(true);
  });

  it('an out-of-scope question ⇒ polite refusal, and the llm is never consulted', async () => {
    const a = await seed();
    // If askRelay reached this llm it would throw — proving the scope gate short-circuits first.
    const llm = new MockLlm(() => {
      throw new Error('llm should not be called for an out-of-scope question');
    });

    const res = await askRelay({ question: "what's the weather?", service: a.service, llm, now: NOW });

    expect(res.intent).toBe('out-of-scope');
    expect(res.source).toBe('template');
    expect(res.usedRts).toBe(false);
    expect(res.citations).toHaveLength(0);
    expect(res.answer).toContain('I track relief operations, not general questions');
  });

  it('with rtsMock ⇒ RTS lights up: usedRts true and a field permalink is cited', async () => {
    const a = await seed();
    const rts = createMockRts((ref) =>
      ref.rtsQuery.includes('Velachery')
        ? {
            snippet: 'Velachery community relief centre is open with capacity for more families.',
            permalink: 'https://slack.example/archives/C1/p1720051200000900',
            sourceLabel: '#field-reports · coordinator',
            channelName: 'field-reports',
          }
        : undefined,
    );

    const res = await askRelay({ question: 'what needs are open in Velachery?', service: a.service, rts, now: NOW });

    expect(res.intent).toBe('by-locality');
    expect(res.usedRts).toBe(true);
    expect(res.citations.some((c) => c.permalink === 'https://slack.example/archives/C1/p1720051200000900')).toBe(true);
    expect(assertNoPii(res.answer).ok).toBe(true);
  });

  it('scrubs PII out of an RTS snippet before it reaches the answer', async () => {
    const a = await seed();
    const rts = createMockRts(() => ({
      snippet: 'Reach the Velachery shelter lead on 98400 12345 for available space.',
      permalink: 'https://slack.example/archives/C1/p1720051200000901',
      sourceLabel: '#field-reports · lead',
      channelName: 'field-reports',
    }));

    const res = await askRelay({ question: 'what is open in Velachery?', service: a.service, rts, now: NOW });

    expect(res.usedRts).toBe(true);
    expect(assertNoPii(res.answer).ok).toBe(true);
    expect(hasContactDigits(res.answer)).toBe(false);
    expect(res.answer).not.toContain('98400');
  });

  const EMERGENCY_RESPONSE =
    'Relay coordinates volunteer relief inside this workspace — it is not an emergency service. For a life-threatening emergency contact your local emergency number directly.';

  it('an emergency-dispatch question returns the safety response — no ledger data, no citations', async () => {
    const a = await seed();
    // If askRelay reached this llm it would throw — the safety pre-check must short-circuit first.
    const llm = new MockLlm(() => {
      throw new Error('llm should not be called for an emergency-dispatch question');
    });

    for (const question of ['should I call 911?', 'dispatch an ambulance to Taramani', 'is this an emergency line?']) {
      const res = await askRelay({ question, service: a.service, llm, now: NOW });
      expect(res.intent).toBe('emergency');
      expect(res.source).toBe('template');
      expect(res.usedRts).toBe(false);
      expect(res.citations).toHaveLength(0);
      expect(res.answer).toBe(EMERGENCY_RESPONSE);
    }
  });

  it('the safety pre-check holds with NO llm key (deterministic)', async () => {
    const a = await seed();
    const res = await askRelay({ question: 'call 108 for an ambulance', service: a.service, now: NOW });
    expect(res.intent).toBe('emergency');
    expect(res.answer).toBe(EMERGENCY_RESPONSE);
    expect(res.citations).toHaveLength(0);
  });

  it('a normal ops question is unaffected by the emergency guard (no false trigger on a bare number)', async () => {
    const a = await seed();
    const res = await askRelay({
      question: 'how many open needs affect over 100 people?',
      service: a.service,
      now: NOW,
    });
    expect(res.intent).not.toBe('emergency');
    expect(res.answer).not.toBe(EMERGENCY_RESPONSE);
    expect(assertNoPii(res.answer).ok).toBe(true);
  });

  it('degrades to ledger-only (usedRts false) when RTS throws', async () => {
    const a = await seed();
    const rts = {
      resolveReference: async () => {
        throw new Error('rts down');
      },
      resolveReferences: async () => {
        throw new Error('rts down');
      },
      isAiSearchEnabled: async () => false,
    };

    const res = await askRelay({ question: 'what needs are open in Velachery?', service: a.service, rts, now: NOW });

    expect(res.usedRts).toBe(false);
    expect(res.intent).toBe('by-locality');
    expect(assertNoPii(res.answer).ok).toBe(true);
  });
});

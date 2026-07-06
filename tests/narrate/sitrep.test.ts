import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { MockLlm } from '../../src/llm/mock';
import { generateSitrep } from '../../src/narrate/sitrep';
import { buildTokenMap, validateNumbers } from '../../src/narrate/statTokens';

// Unit coverage for the live sitrep generator (F6). Uses the hermetic assembly for real ledger
// data and MockLlm through the same boundary the real providers use.

const EVENTS = [
  { eventId: 'Ev1', messageTs: '1720051200.000111', userId: 'U1', text: 'Terrace flooded in Velachery, food needed' },
  { eventId: 'Ev2', messageTs: '1720051201.000222', userId: 'U2', text: 'Dialysis patient stuck near Taramani' },
  {
    eventId: 'Ev3',
    messageTs: '1720051202.000333',
    userId: 'U3',
    text: 'Family trapped on first floor in Pallikaranai',
  },
];

async function seed() {
  const a = buildHermeticAssembly();
  for (const e of EVENTS) await injectIntake(a, e);
  return a;
}

const NOW = Date.parse('2026-07-04T02:00:00.000Z');

describe('generateSitrep — F6 live board', () => {
  it('no llm ⇒ deterministic template; blocks carry a header + grid and numbers match the ledger', async () => {
    const a = await seed();
    const needs = await a.service.listNeeds(NOW);
    const sitrep = await generateSitrep({ service: a.service, now: NOW });

    expect(sitrep.source).toBe('template');
    // headline scalar equals an independent recount.
    expect(sitrep.stats.totalActive).toBe(needs.filter((n) => n.state !== 'CLOSED').length);
    expect(sitrep.stats.totalActive).toBe(3);

    const types = sitrep.blocks.map((b) => b.type);
    expect(types[0]).toBe('header');
    expect(types).toContain('section');
    // The narrative contains only ledger numbers.
    expect(validateNumbers(sitrep.text, buildTokenMap(sitrep.stats.stats).allowedNumbers).ok).toBe(true);
  });

  it('with an llm that uses tokens ⇒ source llm and the rendered numbers are the ledger values', async () => {
    const a = await seed();
    const llm = new MockLlm(() => ({
      narrative: 'The board holds {{stat:total_active}} active needs, {{stat:open}} still open.',
    }));
    const sitrep = await generateSitrep({ service: a.service, llm, now: NOW });

    expect(sitrep.source).toBe('llm');
    expect(sitrep.text).toContain(`${sitrep.stats.totalActive} active needs`);
    expect(sitrep.text).not.toContain('{{stat:');
    expect(validateNumbers(sitrep.text, buildTokenMap(sitrep.stats.stats).allowedNumbers).ok).toBe(true);
  });

  it('a hallucinated number ⇒ falls back to the deterministic template (no stray survives)', async () => {
    const a = await seed();
    const llm = new MockLlm(() => ({ narrative: '{{stat:total_active}} active but 4242 phantom cases reported.' }));
    const sitrep = await generateSitrep({ service: a.service, llm, now: NOW });

    expect(sitrep.source).toBe('template');
    expect(sitrep.text).not.toContain('4242');
    expect(validateNumbers(sitrep.text, buildTokenMap(sitrep.stats.stats).allowedNumbers).ok).toBe(true);
  });
});

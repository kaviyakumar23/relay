import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { emptyFlags, type ProjectedNeed } from '../../src/ledger/types';
import { dispatchCard } from '../../src/surfaces/needCard';
import { parseActionId, type SlackBlock } from '../../src/surfaces/primitives';

// Card builder shape test (BUILD-DOC §F2). The dispatch card is post-extraction now:
// classified header (type + severity + emoji), derived fields, per-field confidence
// chips, a locked reveal-contact control, and the Confirm/Assign row. Two invariants
// are load-bearing: the raw message text NEVER reaches a block (zero-copy, #5), and
// the beneficiary phone number NEVER reaches a block (PII, #5) — the reveal button
// shows no digits.

// A unique marker embedded in the message; extraction ignores it, so it must not
// survive into any rendered block.
const RAW_MARKER = 'ZZ_RAW_BODY_MARKER_ZZ';
const CONTACT_DIGITS = '9840005678';
const MESSAGE = `Family trapped on the terrace in Velachery, 3 people, please call +91 ${CONTACT_DIGITS}. ${RAW_MARKER}`;

async function makeCard(): Promise<{ publicId: string; needId: string; blocks: SlackBlock[]; permalink: string }> {
  const a = buildHermeticAssembly();
  const permalink = 'https://relay.demo/C_RELAY_INTAKE/p1720051200000111';
  await injectIntake(a, {
    eventId: 'Ev01',
    messageTs: '1720051200.000111',
    userId: 'U1',
    text: MESSAGE,
    permalink,
  });
  const card = a.notifier.cards.at(0);
  if (!card) throw new Error('no card recorded');
  return {
    publicId: card.publicId,
    needId: card.needId,
    blocks: dispatchCard(card.publicId, card.projection),
    permalink,
  };
}

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

describe('dispatchCard — post-extraction dispatch card', () => {
  it('renders a classified header with type, severity, and a severity emoji', async () => {
    const { publicId, blocks } = await makeCard();
    const head = blocks[0] as { type: string; text?: { text?: string } };
    expect(head.type).toBe('header');
    expect(head.text?.text).toContain(publicId);
    // "trapped" floors the rescue need to critical.
    expect(head.text?.text).toContain('RESCUE');
    expect(head.text?.text).toContain('CRITICAL');
    expect(head.text?.text).toContain('🔴');
  });

  it('shows the derived fields (locality, headcount, source) and the TRIAGED status', async () => {
    const { blocks, permalink } = await makeCard();
    const dump = jsonOf(blocks);
    expect(dump).toContain('Velachery');
    expect(dump).toContain('People');
    expect(dump).toContain('3');
    expect(dump).toContain(permalink);
    expect(dump).toContain('TRIAGED');
  });

  it('renders per-field confidence chips (stated ✓ / inferred ~ / unknown ?)', async () => {
    const { blocks } = await makeCard();
    const dump = jsonOf(blocks);
    expect(dump).toContain('Confidence:');
    expect(dump).toContain('Severity ✓'); // deterministic floor → stated
    expect(dump).toContain('Locality ✓'); // gazetteer name present → stated
  });

  it('wires Confirm + Assign + a reveal-contact button back to the need id', async () => {
    const { needId, blocks } = await makeCard();
    const ids = blocks
      .filter((b) => (b as { type?: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
      .map((el) => parseActionId(el.action_id));
    expect(ids).toContainEqual({ action: 'need_confirm', id: needId });
    expect(ids).toContainEqual({ action: 'need_assign', id: needId });
    expect(ids).toContainEqual({ action: 'need_reveal', id: needId });
  });

  it('never leaks the raw message text into any block (zero-copy)', async () => {
    const { blocks } = await makeCard();
    expect(jsonOf(blocks)).not.toContain(RAW_MARKER);
  });

  it('never leaks the beneficiary phone number into any block (PII)', async () => {
    const { blocks } = await makeCard();
    const dump = jsonOf(blocks);
    expect(dump).not.toContain(CONTACT_DIGITS);
    expect(dump).not.toContain('98400 05678');
  });
});

describe('dispatchCard — pre-extraction fallback', () => {
  /** A need still in NEW/other (extraction skipped or pending) — no confidence yet. */
  function newNeed(): ProjectedNeed {
    return {
      need_id: 'need_x',
      state: 'NEW',
      type: 'other',
      severity: 'low',
      locality_id: null,
      location_text: null,
      people_count: null,
      languages: [],
      source: { permalink: 'https://relay.demo/x/p1' },
      confidence: {},
      merged_into: null,
      assigned_volunteer_id: null,
      obligation_id: null,
      sla_due_at: null,
      evidence: [],
      flags: emptyFlags(),
      state_version: 1,
      history_count: 1,
      created_at: '2026-07-04T00:00:00.000Z',
      updated_at: '2026-07-04T00:00:00.000Z',
    };
  }

  it('reads UNCLASSIFIED with an extraction-pending note and no reveal button', () => {
    const blocks = dispatchCard('N-0009', newNeed());
    const dump = jsonOf(blocks);
    expect((blocks[0] as { text?: { text?: string } }).text?.text).toContain('UNCLASSIFIED');
    expect(dump).toContain('extraction pending');
    expect(dump).not.toContain('need_reveal');
  });
});

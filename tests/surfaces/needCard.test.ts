import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import type { NeedEvent } from '../../src/ledger/events';
import { type EvidenceKind, emptyFlags, type NeedState, type ProjectedNeed } from '../../src/ledger/types';
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

describe('dispatchCard — agent pledge marker (Moonshot #2)', () => {
  /** A pledged need: an agent filed a PledgeProposed, so it sits at MATCH_SUGGESTED, still awaiting
   * a human confirm (assigned_volunteer_id null). */
  function pledgedNeed(overrides: Partial<ProjectedNeed> = {}): ProjectedNeed {
    return {
      need_id: 'need_p',
      state: 'MATCH_SUGGESTED',
      type: 'food',
      severity: 'high',
      locality_id: 7,
      location_text: 'Adyar',
      people_count: 4,
      languages: [],
      source: { permalink: 'https://relay.demo/x/p7' },
      confidence: {},
      merged_into: null,
      assigned_volunteer_id: null,
      obligation_id: null,
      sla_due_at: null,
      evidence: [],
      flags: emptyFlags(),
      state_version: 3,
      history_count: 4,
      created_at: '2026-07-04T00:00:00.000Z',
      updated_at: '2026-07-04T00:05:00.000Z',
      ...overrides,
    };
  }

  const pledgeEvent = (pledgedBy: string): NeedEvent =>
    ({
      event_id: 'evt_pledge',
      need_id: 'need_p',
      at: '2026-07-04T00:05:00.000Z',
      actor: { type: 'agent', id: `agent:${pledgedBy}` },
      idempotency_key: 'k_pledge',
      type: 'PledgeProposed',
      payload: { volunteer_id: `agent:${pledgedBy}`, pledged_by: pledgedBy },
    }) as NeedEvent;

  it('renders "🤖 Pledged via MCP by <agent> — confirm to track it" for an un-confirmed pledge', () => {
    const blocks = dispatchCard('N-0007', pledgedNeed(), { events: [pledgeEvent('Chennai Food Bank agent')] });
    const dump = jsonOf(blocks);
    expect(dump).toContain('🤖');
    expect(dump).toContain('Pledged via MCP by Chennai Food Bank agent');
    expect(dump).toContain('Confirm to track it');
    // The pre-commit Confirm/Assign row is still offered, so a coordinator can confirm from the card.
    const actionIds = blocks
      .filter((b) => (b as { type?: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
      .map((el) => parseActionId(el.action_id).action);
    expect(actionIds).toContain('need_assign');
  });

  it('hides the pledge marker once a human has confirmed (a volunteer is assigned)', () => {
    const confirmed = pledgedNeed({ state: 'CLAIMED', assigned_volunteer_id: 'agent:chennai-food-bank-agent' });
    const dump = jsonOf(dispatchCard('N-0007', confirmed, { events: [pledgeEvent('Chennai Food Bank agent')] }));
    expect(dump).not.toContain('Pledged via MCP by');
  });
});

describe('dispatchCard — evidence / verification flow (§F5)', () => {
  /** A committed (post-triage) need in the given delivery state, with the given evidence and
   * a vaulted contact so the reveal-visibility rule can be exercised. */
  function deliveringNeed(state: NeedState, kinds: EvidenceKind[]): ProjectedNeed {
    return {
      need_id: 'need_e',
      state,
      type: 'food',
      severity: 'high',
      locality_id: 7,
      location_text: 'Velachery',
      people_count: 5,
      languages: ['ta-en'],
      source: { permalink: 'https://relay.demo/x/p9' },
      confidence: { type: 'stated', contact: 'stated' },
      merged_into: null,
      assigned_volunteer_id: 'SEED_U12',
      obligation_id: 'ob_1',
      sla_due_at: '2026-07-04T00:30:00.000Z',
      evidence: kinds.map((kind, i) => ({ kind, at: `2026-07-04T00:1${i}:00.000Z` })),
      flags: emptyFlags(),
      state_version: 5,
      history_count: 8,
      created_at: '2026-07-04T00:00:00.000Z',
      updated_at: '2026-07-04T00:20:00.000Z',
    };
  }

  const actionIdsOf = (blocks: SlackBlock[]): Array<{ action: string; id: string }> =>
    blocks
      .filter((b) => (b as { type?: string }).type === 'actions')
      .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
      .map((el) => parseActionId(el.action_id));

  it('offers "Mark delivered" (and keeps reveal) while CLAIMED/IN_PROGRESS', () => {
    for (const state of ['CLAIMED', 'IN_PROGRESS'] as const) {
      const ids = actionIdsOf(dispatchCard('N-0001', deliveringNeed(state, [])));
      expect(ids).toContainEqual({ action: 'need_mark_delivered', id: 'need_e' });
      expect(ids).toContainEqual({ action: 'need_reveal', id: 'need_e' });
    }
  });

  it('shows the evidence packet + a policy-gated (locked) sign-off on DELIVERED_UNVERIFIED', () => {
    const blocks = dispatchCard('N-0001', deliveringNeed('DELIVERED_UNVERIFIED', ['photo', 'locality_confirm']));
    const dump = jsonOf(blocks);
    expect(dump).toContain('Evidence packet');
    // high severity needs L3: the sign-off is locked and names what is still missing.
    expect(dump).toContain('Sign-off locked');
    expect(dump).toContain('recipient confirmation');
    const ids = actionIdsOf(blocks);
    expect(ids).toContainEqual({ action: 'need_signoff', id: 'need_e' });
    // still pre-close: reveal is available.
    expect(ids).toContainEqual({ action: 'need_reveal', id: 'need_e' });
  });

  it('enables the sign-off on DELIVERED_UNVERIFIED once L1+L2 are present (missing only sign-off)', () => {
    const blocks = dispatchCard(
      'N-0001',
      deliveringNeed('DELIVERED_UNVERIFIED', ['photo', 'locality_confirm', 'recipient_confirm']),
    );
    const signoffRow = blocks.find(
      (b) =>
        (b as { type?: string }).type === 'actions' &&
        (b as { elements: Array<{ action_id: string; style?: string }> }).elements.some((el) =>
          el.action_id.startsWith('need_signoff:'),
        ),
    ) as { elements: Array<{ style?: string }> };
    expect(signoffRow.elements[0]?.style).toBe('primary');
    expect(jsonOf(blocks)).not.toContain('Sign-off locked');
  });

  it('renders the "Verified · Closed" banner + full packet and hides contact controls when CLOSED', () => {
    const blocks = dispatchCard(
      'N-0001',
      deliveringNeed('CLOSED', ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
    );
    const dump = jsonOf(blocks);
    expect(dump).toContain('Verified · Closed');
    expect(dump).toContain('Verification: L3');
    // The contact controls (reveal button + encrypted note) hide once the loop is closed.
    expect(dump).not.toContain('need_reveal');
    expect(dump).not.toContain('stored encrypted');
    // No "Mark delivered" / sign-off action lingers on a closed need.
    expect(dump).not.toContain('need_mark_delivered');
    expect(dump).not.toContain('need_signoff');
  });

  it('shows a plain "Verified" banner (contact hidden) when VERIFIED but not yet CLOSED', () => {
    const blocks = dispatchCard(
      'N-0001',
      deliveringNeed('VERIFIED', ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
    );
    const dump = jsonOf(blocks);
    expect(dump).toContain('Verified');
    expect(dump).not.toContain('Verified · Closed');
    expect(dump).not.toContain('need_reveal');
  });

  it('adds Edit + Escalate to the committed action row (BUILD-DOC §F2) while in flight', () => {
    for (const state of ['CLAIMED', 'IN_PROGRESS', 'DELIVERED_UNVERIFIED'] as const) {
      const kinds: EvidenceKind[] = state === 'DELIVERED_UNVERIFIED' ? ['photo', 'locality_confirm'] : [];
      const ids = actionIdsOf(dispatchCard('N-0001', deliveringNeed(state, kinds)));
      expect(ids).toContainEqual({ action: 'need_edit', id: 'need_e' });
      expect(ids).toContainEqual({ action: 'need_escalate', id: 'need_e' });
    }
  });

  it('drops Edit + Escalate once the loop is closed (VERIFIED / CLOSED)', () => {
    for (const state of ['VERIFIED', 'CLOSED'] as const) {
      const dump = jsonOf(
        dispatchCard(
          'N-0001',
          deliveringNeed(state, ['photo', 'locality_confirm', 'recipient_confirm', 'coordinator_signoff']),
        ),
      );
      expect(dump).not.toContain('need_edit');
      expect(dump).not.toContain('need_escalate');
    }
  });
});

describe('dispatchCard — visual hierarchy', () => {
  const dividerCount = (blocks: SlackBlock[]): number =>
    blocks.filter((b) => (b as { type?: string }).type === 'divider').length;

  it('separates sections with dividers (identity / fields+confidence / evidence-actions)', async () => {
    const { blocks } = await makeCard();
    // At least the two framing dividers (before fields, after confidence).
    expect(dividerCount(blocks)).toBeGreaterThanOrEqual(2);
  });

  it('prints the confidence-glyph legend exactly ONCE per card', async () => {
    const { blocks } = await makeCard();
    const dump = jsonOf(blocks);
    const legend = '✓ stated · ~ inferred · ? unknown';
    expect(dump.split(legend).length - 1).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { buildHermeticAssembly, injectIntake } from '../../src/demo/driver';
import { dispatchCard } from '../../src/surfaces/needCard';
import { ACTIONS, parseActionId, type SlackBlock } from '../../src/surfaces/primitives';

// Card builder shape test (BUILD-DOC §F2, Day-1 dumb dispatch card). Verifies the
// header, the source/status context, the placeholder chips, the wired action ids,
// and the zero-copy contract (no message text ever reaches a block).

const SECRET = 'CONFIDENTIAL_BENEFICIARY_MESSAGE_BODY';

async function makeCard(): Promise<{ publicId: string; needId: string; blocks: SlackBlock[]; permalink: string }> {
  const a = buildHermeticAssembly();
  const permalink = 'https://relay.demo/C_RELAY_INTAKE/p1720051200000111';
  await injectIntake(a, {
    eventId: 'Ev01',
    messageTs: '1720051200.000111',
    userId: 'U1',
    text: SECRET,
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

describe('dispatchCard — Day-1 dumb dispatch card', () => {
  it('renders an UNCLASSIFIED header with the public id', async () => {
    const { publicId, blocks } = await makeCard();
    const head = blocks[0] as { type: string; text?: { text?: string } };
    expect(head.type).toBe('header');
    expect(head.text?.text).toContain(publicId);
    expect(head.text?.text).toContain('UNCLASSIFIED');
  });

  it('shows the source permalink and NEW status, plus an extraction-pending note', async () => {
    const { blocks, permalink } = await makeCard();
    const dump = jsonOf(blocks);
    expect(dump).toContain(permalink);
    expect(dump).toContain('NEW');
    expect(dump).toContain('extraction pending');
  });

  it('wires Confirm + Assign action ids back to the need id', async () => {
    const { needId, blocks } = await makeCard();
    const actionsBlock = blocks.find((b) => (b as { type?: string }).type === 'actions') as
      | { elements: Array<{ action_id: string }> }
      | undefined;
    if (!actionsBlock) throw new Error('no actions block');
    const parsed = actionsBlock.elements.map((el) => parseActionId(el.action_id));
    expect(parsed).toEqual([
      { action: ACTIONS.confirm, id: needId },
      { action: ACTIONS.assign, id: needId },
    ]);
  });

  it('never leaks the raw message text into any block (zero-copy)', async () => {
    const { blocks } = await makeCard();
    expect(jsonOf(blocks)).not.toContain(SECRET);
  });
});

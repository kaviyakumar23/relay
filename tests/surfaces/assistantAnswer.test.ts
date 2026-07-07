import { describe, expect, it } from 'vitest';
import { buildAssistantAnswer } from '../../src/surfaces/assistantAnswer';
import type { SlackBlock } from '../../src/surfaces/primitives';

// Ask-Relay answer surface (BUILD-DOC §F8). Structured Block Kit: a section for the answer, then
// a compact context block listing each citation as its OWN linked element — never a run-on
// "Sources: a · b · c" line. Pure — asserted off plain JSON.

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

/** The elements of the single context (sources) block, if present. */
function sourceElements(blocks: SlackBlock[]): Array<{ text: string }> {
  const ctx = blocks.find((b) => (b as { type?: string }).type === 'context') as
    | { elements: Array<{ text: string }> }
    | undefined;
  return ctx?.elements ?? [];
}

describe('buildAssistantAnswer', () => {
  it('renders the answer as a section block', () => {
    const blocks = buildAssistantAnswer({ answer: '2 critical needs are still open in Velachery.', citations: [] });
    const first = blocks[0] as { type: string; text?: { text?: string } };
    expect(first.type).toBe('section');
    expect(first.text?.text).toContain('2 critical needs');
  });

  it('lists each citation as its own linked source element (not one collapsed line)', () => {
    const blocks = buildAssistantAnswer({
      answer: 'Two open criticals.',
      citations: [
        { label: 'N0A1B2', permalink: 'https://relay.demo/c/p1' },
        { label: 'N0C3D4', permalink: 'https://relay.demo/c/p2' },
      ],
    });
    const els = sourceElements(blocks);
    // A leading "Sources" label element, then one element PER citation — each its own link.
    const linkEls = els.filter((e) => e.text.includes('https://relay.demo'));
    expect(linkEls).toHaveLength(2);
    expect(linkEls[0]?.text).toContain('<https://relay.demo/c/p1|N0A1B2>');
    expect(linkEls[1]?.text).toContain('<https://relay.demo/c/p2|N0C3D4>');
    // Not collapsed: the two links live in separate elements, never one joined string.
    expect(linkEls[0]?.text).not.toContain('p2');
  });

  it('renders a plain (unlinked) source when a citation has no permalink', () => {
    const blocks = buildAssistantAnswer({ answer: 'One open need.', citations: [{ label: 'field report' }] });
    const els = sourceElements(blocks);
    expect(els.some((e) => e.text.includes('field report'))).toBe(true);
    expect(jsonOf(blocks)).not.toContain('<https');
  });

  it('omits the sources block entirely when there are no citations', () => {
    const blocks = buildAssistantAnswer({ answer: 'No matching needs on the board.', citations: [] });
    expect(blocks.filter((b) => (b as { type?: string }).type === 'context')).toHaveLength(0);
  });

  it('shows only the answer (no citations) for an out-of-scope refusal', () => {
    const blocks = buildAssistantAnswer({
      answer: 'I track relief operations, not general questions.',
      citations: [{ label: 'ignored', permalink: 'https://relay.demo/c/p9' }],
      outOfScope: true,
    });
    expect(blocks.filter((b) => (b as { type?: string }).type === 'context')).toHaveLength(0);
    expect(jsonOf(blocks)).not.toContain('relay.demo');
  });

  it('escapes mrkdwn control chars in a citation label', () => {
    const blocks = buildAssistantAnswer({
      answer: 'A note.',
      citations: [{ label: '<script>&', permalink: 'https://relay.demo/c/p1' }],
    });
    const text = jsonOf(blocks);
    expect(text).toContain('&lt;script&gt;&amp;');
  });
});

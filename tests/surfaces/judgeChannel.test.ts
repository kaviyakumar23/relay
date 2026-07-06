import { describe, expect, it } from 'vitest';
import {
  buildArchitecture,
  buildGuidedTour,
  buildJudgeWelcome,
  JUDGE_ARCH,
  JUDGE_RESET,
  JUDGE_RUN_DEMO,
  JUDGE_TOUR,
  QUALIFYING_TECHS,
  TOUR_STEPS,
} from '../../src/surfaces/judgeChannel';
import type { SlackBlock } from '../../src/surfaces/primitives';

// Pure Block Kit builders for #judges-start-here: the welcome (4 buttons), the
// six-step tour, and the architecture card. Asserted off plain JSON — no Slack.

const actionIds = (blocks: SlackBlock[]): string[] =>
  blocks
    .filter((b) => (b as { type?: string }).type === 'actions')
    .flatMap((b) => (b as { elements: Array<{ action_id: string }> }).elements)
    .map((el) => el.action_id);

const sections = (blocks: SlackBlock[]): SlackBlock[] =>
  blocks.filter((b) => (b as { type?: string }).type === 'section');

const dump = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

describe('buildJudgeWelcome', () => {
  it('offers exactly the four judge actions, in order', () => {
    expect(actionIds(buildJudgeWelcome())).toEqual([JUDGE_RUN_DEMO, JUDGE_RESET, JUDGE_TOUR, JUDGE_ARCH]);
  });

  it('states the honesty framing: fictional data, compressed SLAs, 🧪 simulator', () => {
    const text = dump(buildJudgeWelcome());
    expect(text).toContain('🧪');
    expect(text.toLowerCase()).toContain('fictional');
    expect(text.toLowerCase()).toContain('compressed');
  });

  it('names the /relay demo command equivalents for the buttons', () => {
    const text = dump(buildJudgeWelcome());
    expect(text).toContain('/relay demo start flood-1');
    expect(text).toContain('/relay demo reset');
  });
});

describe('buildGuidedTour', () => {
  it('has exactly six steps', () => {
    expect(TOUR_STEPS).toHaveLength(6);
    // Every step renders as a section, plus the intro/outro are context blocks.
    expect(sections(buildGuidedTour())).toHaveLength(6);
  });

  it('walks all four channels and names the commands to try', () => {
    const text = dump(buildGuidedTour());
    for (const channel of ['#relay-intake', '#relay-dispatch', '#relay-volunteers', '#relay-hq']) {
      expect(text).toContain(channel);
    }
    expect(text).toContain('/relay sitrep');
    expect(text).toContain('/relay report');
  });
});

describe('buildArchitecture', () => {
  it('names the three qualifying technologies', () => {
    expect(QUALIFYING_TECHS).toHaveLength(3);
    const text = dump(buildArchitecture());
    expect(text).toContain('Slack AI');
    expect(text).toContain('Real-Time Search');
    expect(text).toContain('MCP');
  });

  it('carries a repo link placeholder and the append-only framing', () => {
    const text = dump(buildArchitecture());
    expect(text).toContain('github.com');
    expect(text).toContain('append-only');
  });
});

import { divider, escapeMrkdwn, type SlackBlock, section } from './primitives';

// Ask-Relay answer surface (BUILD-DOC §F8 / the Slack-AI qualifying technology). The current
// assistant reply is run-on prose with every source collapsed into a single "Sources: a · b · c"
// line. This renders the same AskRelay result as structured Block Kit instead: a section for the
// answer, then — for in-scope answers — a compact context block listing each citation as its own
// linked source element (never a run-on links line). Pure over its inputs: no Slack client, no
// store, so it unit-tests off plain JSON. The integrator swaps the prose builder for this.
//
// The input is structurally the AskRelayResult slice (answer / citations / out-of-scope). Sources
// are kept as their own type so this surface stays a leaf (no import from src/assistant).

/** One cited source — structurally identical to askRelay's AnswerCitation. */
export interface AnswerSource {
  label: string;
  permalink?: string;
}

export interface AssistantAnswerArgs {
  /** The synthesised (or template) answer text — mrkdwn. */
  answer: string;
  /** The sources backing the answer; each is rendered as its own linked element. */
  citations: AnswerSource[];
  /** True when the question was refused as out-of-relief-scope (citations are suppressed). */
  outOfScope?: boolean;
}

/** Context blocks reject an empty elements array and cap at 10; keep a headroom under that. */
const MAX_SOURCES = 8;

/** A single source element: a Slack link when we have a permalink, else the escaped label. */
function sourceText(c: AnswerSource): string {
  const label = escapeMrkdwn(c.label);
  return c.permalink !== undefined && c.permalink.length > 0 ? `🔗 <${c.permalink}|${label}>` : `• ${label}`;
}

/** The sources row: a leading label element, then one element per citation (not a run-on line). */
function sourcesBlock(cites: AnswerSource[]): SlackBlock {
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '*Sources*' }, ...cites.map((c) => ({ type: 'mrkdwn', text: sourceText(c) }))],
  };
}

/**
 * Build the Ask-Relay reply blocks. Always a section with the answer; for in-scope answers with
 * sources, a compact context block that lists each citation as its own linked element. Refusals
 * (out-of-scope) render the answer alone. Pure.
 */
export function buildAssistantAnswer(args: AssistantAnswerArgs): SlackBlock[] {
  const answer = args.answer.trim();
  const blocks: SlackBlock[] = [section(answer.length > 0 ? answer : '_No answer available._')];

  if (args.outOfScope === true) return blocks;

  const cites = args.citations.slice(0, MAX_SOURCES);
  if (cites.length > 0) {
    blocks.push(divider, sourcesBlock(cites));
  }
  return blocks;
}

import { actions, context, divider, header, type SlackBlock, section } from './primitives';

// #judges-start-here — the judge on-ramp (BUILD-DOC F8). Pure Block Kit builders,
// no Slack client, so they unit-test off plain JSON. The integrator publishes
// buildJudgeWelcome() at boot and wires the four buttons (and the /relay demo
// command equivalents) to the injector + reset + these builders.
//
// Action ids here are GLOBAL (no `action:entityId` target), so they are exact
// strings the integrator can register with app.action('judge_run_demo', …).

export const JUDGE_RUN_DEMO = 'judge_run_demo';
export const JUDGE_RESET = 'judge_reset';
export const JUDGE_TOUR = 'judge_tour';
export const JUDGE_ARCH = 'judge_arch';

/** Swapped for the real repo URL at submission (eval-honesty: no dead links in the demo). */
const REPO_URL_PLACEHOLDER = 'https://github.com/<org>/relay';

/** A global (entity-less) button: a plain, exact action_id — not an `action:id` target. */
function judgeButton(text: string, actionId: string, style?: 'primary' | 'danger'): SlackBlock {
  return {
    type: 'button',
    text: { type: 'plain_text', text, emoji: true },
    action_id: actionId,
    value: actionId,
    ...(style ? { style } : {}),
  };
}

/**
 * The welcome card: a one-paragraph pitch, the honesty framing (fictional data +
 * compressed SLAs + 🧪 simulator), and the four judge actions.
 */
export function buildJudgeWelcome(): SlackBlock[] {
  return [
    header('Relay · judges, start here'),
    section(
      '*Relay* is a Slack-native agent for *verified* volunteer crisis response — ' +
        'intake → triage → match → commit → verify → report, on an append-only ledger. ' +
        'Relay never treats a single message as truth: the AI reads language, deterministic code controls state, ' +
        'and a human confirms every consequential step.',
    ),
    context(
      '🧪 Everything here is *fictional* — a made-up flood, invented names, obviously-fake phone numbers. ' +
        'Demo SLAs are *compressed ~50×* so the drift → reassign story fires in minutes. ' +
        'Every simulated message is posted by the 🧪 Relay Simulator identity, so you always know what is staged.',
    ),
    divider,
    section('*Run the ~3-minute story, then explore the channels:*'),
    actions([
      judgeButton('▶ Run flood demo', JUDGE_RUN_DEMO, 'primary'),
      judgeButton('↺ Reset demo', JUDGE_RESET, 'danger'),
      judgeButton('🧭 Guided tour', JUDGE_TOUR),
      judgeButton('📄 Architecture', JUDGE_ARCH),
    ]),
    context('Prefer the keyboard? `/relay demo start flood-1` runs it · `/relay demo reset` clears the board.'),
  ];
}

export interface TourStep {
  title: string;
  body: string;
}

/** The six-stop walkthrough: the four-channel flow, then what to try. */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: '1 · #relay-intake — the flood lands',
    body:
      'Raw cries for help arrive here (staged as 🧪 personas). Relay extracts a structured *need* from each — ' +
      'type, severity, locality, people — and *floors* severity on life-safety keywords (trapped, dialysis, child) ' +
      'that a model can never lower.',
  },
  {
    title: '2 · #relay-dispatch — one card per need',
    body:
      'Every need becomes a dispatch card. Coordinators *confirm triage*, see *duplicate* banners (a repeated phone ' +
      'auto-links; a reworded report is only *proposed* for human merge), and *assign* a volunteer. Nothing ' +
      'consequential happens without a human tap.',
  },
  {
    title: '3 · #relay-volunteers — claims & the hero moment',
    body:
      'Volunteers *self-claim* needs. As an obligation nears its (compressed) SLA, Relay *DM-nudges* the volunteer; ' +
      'if they *release*, the drift engine proposes a *reassignment* to the next-best volunteer — the demo’s hero moment.',
  },
  {
    title: '4 · #relay-hq — sitreps & donor reports',
    body:
      'Situation reports and donor reports post here. Every number is a live projection of the ledger — a fabricated ' +
      'figure is rejected and falls back to a plain template — and beneficiary PII never appears (it lives only in ' +
      'the encrypted vault).',
  },
  {
    title: '5 · Try the commands',
    body:
      'Run `/relay sitrep` for the live board, `/relay report` for a verified-impact summary, and `/relay volunteers` ' +
      'for the roster. A delivery only *closes* on evidence: photo + locality + recipient confirm + coordinator sign-off.',
  },
  {
    title: '6 · Ask Relay',
    body:
      'Open Relay’s *Assistant* pane and ask “what’s still open in Velachery?”. Answers are grounded in the ledger ' +
      'and cite Slack permalinks via Real-Time Search — never invented, never persisted.',
  },
];

/** The guided-tour message: the six steps as sections, bookended by context. */
export function buildGuidedTour(): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header('Relay · guided tour'),
    context('Four channels, one ledger. Follow a need from a cry for help to a proven delivery.'),
    divider,
  ];
  for (const step of TOUR_STEPS) blocks.push(section(`*${step.title}*\n${step.body}`));
  blocks.push(
    divider,
    context('Ready? Hit *▶ Run flood demo* in #judges-start-here and watch it flow through these four channels.'),
  );
  return blocks;
}

export interface QualifyingTech {
  name: string;
  detail: string;
}

/** The three qualifying technologies the shipped code actually uses (eval-honesty). */
export const QUALIFYING_TECHS: readonly QualifyingTech[] = [
  {
    name: 'Slack AI capabilities',
    detail:
      'The Assistant pane (assistant.threads) answers coordinator questions grounded in the ledger — plus App Home, ' +
      'modals, and Block Kit dispatch cards as the entire operating surface.',
  },
  {
    name: 'Real-Time Search (RTS)',
    detail:
      'Ask-Relay grounds answers in live Slack context via assistant.search.context and cites permalinks — results ' +
      'are query-time only and never persisted (API ToS).',
  },
  {
    name: 'Model Context Protocol (MCP)',
    detail:
      'A read-only MCP server exposes the ledger (needs, sitrep) to external agents through the same PII-free ' +
      'projections the app uses — never the vault.',
  },
];

export interface EvalMetric {
  label: string;
  value: string;
  detail: string;
}

/**
 * The measured, reproducible extraction metrics (`npm run eval` over the frozen 40-message
 * labelled intake set — eval/intake_set.jsonl). These are the honest numbers the eval harness
 * actually computes (CLAUDE.md eval-honesty: publish only what `npm run eval` produced; never
 * invent a figure). Surfaced here so judges SEE the Technological-Implementation evidence.
 */
export const EVAL_METRICS: readonly EvalMetric[] = [
  {
    label: 'Field-extraction accuracy',
    value: '86.1%',
    detail: 'type · severity · locality · people vs. hand-labelled gold, over attempted extractions',
  },
  {
    label: 'Critical-severity recall',
    value: '100%',
    detail: 'every life-safety need caught — deterministic keyword floors the model can never lower',
  },
  {
    label: 'Contact & locality accuracy',
    value: '100%',
    detail: 'phone detection/redaction and gazetteer locality resolution on the labelled set',
  },
];

/** The architecture message: the event-sourced core, the three qualifying techs, the measured
 *  eval numbers, and PII posture. */
export function buildArchitecture(): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header('Relay · architecture'),
    section(
      '*Event-sourced core.* `need_events` is append-only; `needs.status` is a projection derived from events. ' +
        'The LLM interprets language at the boundary (Zod-validated — one repair pass, else human review); ' +
        'deterministic code owns every state transition; humans gate every consequential change.',
    ),
    divider,
    section('*Qualifying technologies*'),
  ];
  for (const tech of QUALIFYING_TECHS) blocks.push(section(`*${tech.name}*\n${tech.detail}`));
  blocks.push(
    divider,
    section(
      '*Measured performance — reproducible.* Extraction scored on a frozen *40-message* hand-labelled ' +
        'intake set. These are the numbers `npm run eval` computes — not estimates, not claims:',
    ),
  );
  for (const m of EVAL_METRICS) blocks.push(section(`*${m.value}* · ${m.label}\n${m.detail}`));
  blocks.push(
    context('Reproduce: `npm run eval` (deterministic scorer, `eval/score.ts`; gold set `eval/intake_set.jsonl`).'),
    divider,
    section(
      '*PII & honesty.* Beneficiary contact lives only in an AES-256-GCM vault, redacted before any LLM call; ' +
        'donor reports carry only verified, source-linked numbers.',
    ),
    context(`Repo: ${REPO_URL_PLACEHOLDER} · all demo data is fictional and flagged \`is_demo\`.`),
  );
  return blocks;
}

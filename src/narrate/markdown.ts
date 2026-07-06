// The report Markdown renderer (F7): turns an already-narrated, already-scrubbed report
// into a clean, downloadable Markdown document. PURE — no I/O, no LLM, no Slack. The
// integrator scrubs the LLM INPUT (scrubText) and hard-asserts the FINAL output
// (assertNoPii) around this; this module only lays out text it is given.
//
// Every figure carries its ledger refs and every ref resolves to a footnote, so a donor
// reading the doc can trace each number back to the event that verified it. This is the
// number-integrity discipline ported from ../impactlens (blessed figures + source links)
// expressed as Markdown rather than Block Kit.

/** One verified figure: a human label, a display value, and the ledger refs that back it. */
export interface ReportStat {
  label: string;
  value: string | number;
  /** Footnote ids that justify this figure, e.g. ['N-1a2b', 'N-3c4d']. */
  refs?: string[];
}

/** A footnote mapping a `[N-xxxx]` ref to the ledger event it points at. */
export interface ReportFootnote {
  id: string;
  /** Human description of the backing event (type + actor + time), already PII-free. */
  event: string;
  /** Optional permalink to the source message / event. */
  permalink?: string;
}

export interface ReportInput {
  title: string;
  period: string;
  narrative: string;
  stats: ReportStat[];
  footnotes: ReportFootnote[];
}

/** Neutralize a value for a Markdown table cell: pipes would break the column, and a
 * newline would break the row. Collapse both. */
function cell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** Render a footnote id as a bracketed ref, idempotently ('N-1a2b' → '[N-1a2b]'). */
function fnRef(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith('[') ? trimmed : `[${trimmed}]`;
}

function formatValue(value: string | number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toLocaleString('en-US');
  return String(value);
}

/**
 * Render the full report as a Markdown document string: title, period, the narrative, a
 * '## Verified figures' table (label | value | ledger refs), and a '## Footnotes' section
 * mapping each ref to its event. Pure.
 */
export function renderReportMarkdown(input: ReportInput): string {
  const { title, period, narrative, stats, footnotes } = input;
  const lines: string[] = [];

  lines.push(`# ${title.trim()}`);
  lines.push('');
  lines.push(`_Period: ${period.trim()}_`);
  lines.push('');
  lines.push(narrative.trim());
  lines.push('');

  lines.push('## Verified figures');
  lines.push('');
  if (stats.length === 0) {
    lines.push('_No verified figures for this period._');
  } else {
    lines.push('| Figure | Value | Ledger refs |');
    lines.push('| --- | --- | --- |');
    for (const s of stats) {
      const refs = (s.refs ?? []).map(fnRef).join(', ');
      lines.push(`| ${cell(s.label)} | ${cell(formatValue(s.value))} | ${cell(refs || '—')} |`);
    }
  }
  lines.push('');

  lines.push('## Footnotes');
  lines.push('');
  if (footnotes.length === 0) {
    lines.push('_No footnotes._');
  } else {
    for (const f of footnotes) {
      const link = f.permalink ? ` ([source](${f.permalink}))` : '';
      lines.push(`- **${fnRef(f.id)}** — ${f.event.trim()}${link}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

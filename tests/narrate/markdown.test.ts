import { describe, expect, it } from 'vitest';
import { type ReportInput, renderReportMarkdown } from '../../src/narrate/markdown';

// The report Markdown renderer (F7): heading, period, narrative, a verified-figures table,
// and footnotes mapping each [N-xxxx] ref to its ledger event. Pure.

const base: ReportInput = {
  title: 'Relay — Chennai floods',
  period: 'Jul 4–9, 2026',
  narrative: 'Across the window, verified deliveries reached the worst-hit localities first.',
  stats: [
    { label: 'Needs verified', value: 1240, refs: ['N-1a2b', 'N-3c4d'] },
    { label: 'Localities covered', value: 9, refs: ['N-5e6f'] },
  ],
  footnotes: [
    { id: 'N-1a2b', event: 'verify-close by coordinator at 2026-07-08T10:00:00Z', permalink: 'https://x/1' },
    { id: 'N-3c4d', event: 'verify-close by coordinator at 2026-07-08T11:00:00Z' },
    { id: 'N-5e6f', event: 'locality confirm at 2026-07-07T09:00:00Z', permalink: 'https://x/2' },
  ],
};

describe('renderReportMarkdown', () => {
  it('renders the heading, period, and narrative', () => {
    const md = renderReportMarkdown(base);
    expect(md).toContain('# Relay — Chennai floods');
    expect(md).toContain('_Period: Jul 4–9, 2026_');
    expect(md).toContain('Across the window, verified deliveries');
  });

  it('renders a Verified figures table with label, formatted value, and ledger refs', () => {
    const md = renderReportMarkdown(base);
    expect(md).toContain('## Verified figures');
    expect(md).toContain('| Figure | Value | Ledger refs |');
    expect(md).toContain('| --- | --- | --- |');
    // 1240 formatted with a thousands separator; refs bracketed
    expect(md).toContain('| Needs verified | 1,240 | [N-1a2b], [N-3c4d] |');
    expect(md).toContain('| Localities covered | 9 | [N-5e6f] |');
  });

  it('renders a Footnotes section mapping each ref to its event with optional source links', () => {
    const md = renderReportMarkdown(base);
    expect(md).toContain('## Footnotes');
    expect(md).toContain(
      '- **[N-1a2b]** — verify-close by coordinator at 2026-07-08T10:00:00Z ([source](https://x/1))',
    );
    // no permalink → no link suffix
    expect(md).toContain('- **[N-3c4d]** — verify-close by coordinator at 2026-07-08T11:00:00Z');
    expect(md).not.toContain('- **[N-3c4d]** — verify-close by coordinator at 2026-07-08T11:00:00Z (');
  });

  it('escapes pipes in a table cell so the column cannot break', () => {
    const md = renderReportMarkdown({
      ...base,
      stats: [{ label: 'Food | water combined', value: '3 | 4', refs: [] }],
    });
    expect(md).toContain('| Food \\| water combined | 3 \\| 4 | — |');
  });

  it('renders placeholders when there are no figures or footnotes', () => {
    const md = renderReportMarkdown({ ...base, stats: [], footnotes: [] });
    expect(md).toContain('_No verified figures for this period._');
    expect(md).toContain('_No footnotes._');
    expect(md).not.toContain('| Figure | Value | Ledger refs |');
  });
});

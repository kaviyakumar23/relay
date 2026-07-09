import { describe, expect, it } from 'vitest';
import { emptyFlags, type NeedState, type NeedType, type ProjectedNeed, type Severity } from '../../src/ledger/types';
import { buildOpsMapSvg, type OpsMapLocality, SEVERITY_COLOR } from '../../src/surfaces/opsMap';

// The live operations map (sitrep garnish). A PURE, deterministic SVG string using ONLY fictional
// gazetteer coordinates + the ledger's derived fields — never PII.

const LOCALITIES: OpsMapLocality[] = [
  { id: 1, lat: 13.0, lng: 80.2 },
  { id: 2, lat: 13.05, lng: 80.25 },
  { id: 3, lat: 12.95, lng: 80.15 },
];

function need(
  severity: Severity,
  localityId: number | null,
  locationText: string | null,
  state: NeedState = 'CLAIMED',
  type: NeedType = 'food',
): ProjectedNeed {
  return {
    need_id: `n-${Math.random()}`,
    state,
    type,
    severity,
    locality_id: localityId,
    location_text: locationText,
    people_count: 3,
    languages: ['en'],
    source: {},
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

describe('buildOpsMapSvg', () => {
  it('renders an empty-state SVG when no need has a mapped locality', () => {
    const svg = buildOpsMapSvg([], LOCALITIES);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('No active needs');
  });

  it('renders a marker map with severity colour, locality label and a count', () => {
    const needs = [
      need('critical', 1, 'Taramani'),
      need('high', 1, 'Taramani'), // same locality → aggregated, worst severity wins
      need('low', 2, 'Perungudi'),
    ];
    const svg = buildOpsMapSvg(needs, LOCALITIES);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain(SEVERITY_COLOR.critical); // locality 1's worst severity is critical
    expect(svg).toContain(SEVERITY_COLOR.low); // locality 2 is low
    expect(svg).toContain('Taramani');
    expect(svg).toContain('Perungudi');
    // 3 needs across 2 localities.
    expect(svg).toContain('3 needs across 2 localities');
  });

  it('counts needs whose locality does not resolve as off-map', () => {
    const needs = [need('high', 1, 'Taramani'), need('medium', 99, 'Nowhere')];
    const svg = buildOpsMapSvg(needs, LOCALITIES);
    expect(svg).toContain('1 off-map');
  });

  it('is deterministic — identical input yields identical bytes', () => {
    const a = need('critical', 1, 'Taramani');
    a.need_id = 'a';
    const b = need('low', 3, 'Pallikaranai');
    b.need_id = 'b';
    const needs = [a, b];
    expect(buildOpsMapSvg(needs, LOCALITIES)).toBe(buildOpsMapSvg(needs, LOCALITIES));
  });

  it('XML-escapes a location label so it can never break the document', () => {
    const svg = buildOpsMapSvg([need('high', 1, 'A & B <zone>')], LOCALITIES);
    expect(svg).toContain('A &amp; B &lt;zone&gt;');
    expect(svg).not.toContain('A & B <zone>');
  });

  it('exposes a colour for every severity', () => {
    for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
      expect(SEVERITY_COLOR[sev]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

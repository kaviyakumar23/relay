import { type ProjectedNeed, SEVERITY_RANK, type Severity } from '../ledger/types';

// The live operations map (Moonshot — sitrep garnish). A PURE, deterministic SVG string (no
// clock, no random, no env): given the current needs + the fictional seed gazetteer, it plots
// each affected locality as a marker sized by need-count and coloured by its worst severity.
//
// THE ETHOS: this map uses ONLY fictional gazetteer coordinates (seed/localities.json, a real
// place-name list on a fictional grid) plus the ledger's own derived fields. It is a garnish on
// the sitrep, uploaded best-effort; it is never a source of truth and never shows PII (it reads
// only locality_id, severity, state and the derived location_text label).

/** A gazetteer point the map can plot a need onto. Structurally a superset of match `LocalityCoord`
 * (id/lat/lng) so the live wiring can pass its existing coord list straight through; `name` is
 * optional and used as the marker label when present. */
export interface OpsMapLocality {
  id: number;
  lat: number;
  lng: number;
  name?: string;
}

/** Severity → marker colour, from the dataviz status palette, chosen to read ≥3:1 on the dark
 * command-centre surface below. Ordered worst→best for the legend. */
export const SEVERITY_COLOR: Record<Severity, string> = {
  critical: '#ef6f6c',
  high: '#f0a35e',
  medium: '#e8c65b',
  low: '#63c187',
};

const SURFACE = '#0e1621';
const PANEL = '#132030';
const GRID = '#22344a';
const INK = '#e6edf5';
const MUTED = '#8aa0b6';

const W = 920;
const H = 560;
const PAD_L = 56;
const PAD_R = 40;
const PAD_T = 96;
const PAD_B = 88;

/** Escape the five XML-significant characters so a location label can never break the document. */
function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const round = (n: number): number => Math.round(n * 10) / 10;

/** One plotted locality: its coordinate, the count of needs there, the worst severity, and a label. */
interface MapPoint {
  lat: number;
  lng: number;
  count: number;
  severity: Severity;
  label: string;
}

const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low'];

/** Aggregate needs onto their gazetteer localities (deterministic, sorted by locality id). Only
 * needs whose locality resolves to a coordinate are plotted; the rest are counted as "off-map". */
function aggregate(needs: ProjectedNeed[], byId: Map<number, OpsMapLocality>): { points: MapPoint[]; offMap: number } {
  const acc = new Map<number, { count: number; rank: number; severity: Severity; label: string }>();
  let offMap = 0;
  for (const need of needs) {
    const loc = need.locality_id !== null ? byId.get(need.locality_id) : undefined;
    if (loc === undefined) {
      offMap += 1;
      continue;
    }
    const rank = SEVERITY_RANK[need.severity];
    const existing = acc.get(loc.id);
    const label = loc.name ?? need.location_text ?? `Locality ${loc.id}`;
    if (existing === undefined) {
      acc.set(loc.id, { count: 1, rank, severity: need.severity, label });
    } else {
      existing.count += 1;
      if (rank > existing.rank) {
        existing.rank = rank;
        existing.severity = need.severity;
      }
    }
  }
  const points: MapPoint[] = [];
  for (const id of [...acc.keys()].sort((a, b) => a - b)) {
    const loc = byId.get(id);
    const a = acc.get(id);
    if (loc === undefined || a === undefined) continue;
    points.push({ lat: loc.lat, lng: loc.lng, count: a.count, severity: a.severity, label: a.label });
  }
  return { points, offMap };
}

/** Equirectangular projection of lat/lng into the plot rectangle, robust to a degenerate span. */
function projector(points: MapPoint[]): (p: MapPoint) => { x: number; y: number } {
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  return (p) => {
    const fx = (p.lng - minLng) / spanLng;
    const fy = (p.lat - minLat) / spanLat;
    return {
      x: round(PAD_L + fx * plotW),
      y: round(PAD_T + (1 - fy) * plotH), // north is up
    };
  };
}

/** Truncate a marker label so it stays readable on the map. */
const clip = (s: string, n = 20): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function legend(): string {
  const items = SEVERITY_ORDER.map((sev, i) => {
    const x = PAD_L + i * 150;
    const y = H - 34;
    return (
      `<circle cx="${x}" cy="${y}" r="6" fill="${SEVERITY_COLOR[sev]}" />` +
      `<text x="${x + 14}" y="${y + 4}" fill="${MUTED}" font-size="13">${xml(sev)}</text>`
    );
  }).join('');
  return items;
}

function emptyState(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${SURFACE}" />` +
    `<text x="${W / 2}" y="40" fill="${INK}" font-size="22" font-weight="700" text-anchor="middle">` +
    `Relay — live operations map</text>` +
    `<text x="${W / 2}" y="${H / 2}" fill="${MUTED}" font-size="16" text-anchor="middle">` +
    `No active needs with a mapped locality yet.</text>` +
    `<text x="${W / 2}" y="${H - 24}" fill="${MUTED}" font-size="12" text-anchor="middle">` +
    `Positions from the fictional seed gazetteer · not a real map.</text>` +
    `</svg>`
  );
}

/**
 * Render the current needs as a dark command-centre operations map (an SVG string). Needs are
 * aggregated onto their fictional gazetteer localities; each marker is sized by count and coloured
 * by the worst severity present. Deterministic given (needs, localities) — same input, same bytes.
 */
export function buildOpsMapSvg(needs: ProjectedNeed[], localities: OpsMapLocality[]): string {
  const byId = new Map<number, OpsMapLocality>(localities.map((l) => [l.id, l]));
  const { points, offMap } = aggregate(needs, byId);
  if (points.length === 0) return emptyState();

  const project = projector(points);
  const totalPlotted = points.reduce((n, p) => n + p.count, 0);

  const markers = points
    .map((p) => {
      const { x, y } = project(p);
      const r = round(9 + Math.sqrt(p.count) * 5);
      const color = SEVERITY_COLOR[p.severity];
      const labelY = round(y - r - 6);
      return (
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" fill-opacity="0.28" ` +
        `stroke="${color}" stroke-width="2" />` +
        `<circle cx="${x}" cy="${y}" r="3" fill="${color}" />` +
        `<text x="${x}" y="${round(y + 4)}" fill="${SURFACE}" font-size="11" font-weight="700" ` +
        `text-anchor="middle">${p.count}</text>` +
        `<text x="${x}" y="${labelY}" fill="${INK}" font-size="12" text-anchor="middle">${xml(clip(p.label))}</text>`
      );
    })
    .join('');

  // A faint reference grid so the plot reads as a map, not a scatter of dots.
  const gridLines: string[] = [];
  for (let gx = PAD_L; gx <= W - PAD_R; gx += 90) {
    gridLines.push(`<line x1="${gx}" y1="${PAD_T}" x2="${gx}" y2="${H - PAD_B}" stroke="${GRID}" stroke-width="1" />`);
  }
  for (let gy = PAD_T; gy <= H - PAD_B; gy += 76) {
    gridLines.push(`<line x1="${PAD_L}" y1="${gy}" x2="${W - PAD_R}" y2="${gy}" stroke="${GRID}" stroke-width="1" />`);
  }

  const subtitle =
    `${totalPlotted} need${totalPlotted === 1 ? '' : 's'} across ${points.length} ` +
    `${points.length === 1 ? 'locality' : 'localities'}` +
    (offMap > 0 ? ` · ${offMap} off-map` : '');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ` +
    `font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif">` +
    `<rect width="${W}" height="${H}" fill="${SURFACE}" />` +
    `<rect x="${PAD_L - 16}" y="${PAD_T - 16}" width="${W - PAD_L - PAD_R + 32}" height="${H - PAD_T - PAD_B + 32}" ` +
    `rx="12" fill="${PANEL}" />` +
    gridLines.join('') +
    markers +
    `<text x="${PAD_L - 16}" y="40" fill="${INK}" font-size="22" font-weight="700">Relay — live operations map</text>` +
    `<text x="${PAD_L - 16}" y="64" fill="${MUTED}" font-size="14">${xml(subtitle)}</text>` +
    legend() +
    `<text x="${W - PAD_R}" y="${H - 24}" fill="${MUTED}" font-size="12" text-anchor="end">` +
    `Positions from the fictional seed gazetteer · not a real map.</text>` +
    `</svg>`
  );
}

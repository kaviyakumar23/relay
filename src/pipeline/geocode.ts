import { readFileSync } from 'node:fs';
import { z } from 'zod';

// Gazetteer resolver (BUILD-DOC §16.4). Turns a free-text locality_guess into a stable
// locality id by matching (case/whitespace-insensitively) against the seeded gazetteer's
// canonical name and its alias list. Pure aside from a single, cached read of
// seed/localities.json at first use — no clock, no network, no env.
//
// seed/localities.json has NO explicit `id` field, so ids are assigned deterministically
// as the 1-based array index (first entry → id 1). This ordering is the contract the
// rest of the pipeline relies on; do not reorder the seed without a migration.

const LocalitySeedSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
  lat: z.number(),
  lng: z.number(),
});

export interface ResolvedLocality {
  /** 1-based gazetteer id (array index + 1) on a match, else null. */
  localityId: number | null;
  /** On no match, the original guess is passed through as free-text location detail. */
  locationText: string | null;
  matched: boolean;
}

/** Case/whitespace-insensitive normalization key used for both index build and lookup. */
function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

let cachedIndex: Map<string, number> | null = null;

/** Build (once) the normalized name/alias → id lookup from the seed file. */
function localityIndex(): Map<string, number> {
  if (cachedIndex !== null) return cachedIndex;
  const raw = readFileSync(new URL('../../seed/localities.json', import.meta.url), 'utf8');
  const entries = z.array(LocalitySeedSchema).parse(JSON.parse(raw));
  const index = new Map<string, number>();
  entries.forEach((entry, i) => {
    const id = i + 1; // stable 1-based id by array order (seed has no explicit id field)
    index.set(normKey(entry.name), id);
    for (const alias of entry.aliases) index.set(normKey(alias), id);
  });
  cachedIndex = index;
  return index;
}

/**
 * Resolve a locality guess to a gazetteer id. On match: { localityId, locationText: null,
 * matched: true }. On no match (or a blank/null guess): { localityId: null, locationText:
 * guess, matched: false } so the caller keeps the guess as free-text location detail.
 */
export function resolveLocality(guess: string | null): ResolvedLocality {
  if (guess === null) return { localityId: null, locationText: null, matched: false };
  const key = normKey(guess);
  if (key === '') return { localityId: null, locationText: guess, matched: false };
  const id = localityIndex().get(key);
  if (id === undefined) return { localityId: null, locationText: guess, matched: false };
  return { localityId: id, locationText: null, matched: true };
}

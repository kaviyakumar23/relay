import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { resolveLocality } from '../pipeline/geocode';
import type { LocalityCoord } from './scorer';
import type { Volunteer } from './volunteerStore';

// Hermetic loaders for the seeded roster + gazetteer (seed/volunteers.json,
// seed/localities.json). Used by `npm run demo` and by live mode without a DB so the
// matcher has candidates and coordinates with zero env. The Postgres seed path
// (src/demo/seed.ts) is unchanged; this is its in-memory twin, reusing the SAME
// gazetteer ordering (id = 1-based array index) that geocode.resolveLocality assigns.

const VolunteerSeedSchema = z.object({
  slack_user_id: z.string().min(1),
  display_name: z.string().min(1),
  skills: z.array(z.string()),
  languages: z.array(z.string()),
  home_locality: z.string().min(1),
  radius_km: z.number().int().positive(),
  capacity_per_day: z.number().int().positive(),
  availability: z.record(z.string(), z.unknown()),
});

const LocalitySeedSchema = z.object({
  name: z.string().min(1),
  aliases: z.array(z.string()),
  lat: z.number(),
  lng: z.number(),
});

/**
 * Load the seeded volunteer roster into `Volunteer` rows. Home-locality names are
 * resolved to gazetteer ids via geocode (unresolved → null), matching how the live
 * seed maps names to localities.id. `active_load` starts at 0.
 */
export function loadSeedVolunteers(opts: { isDemo?: boolean } = {}): Volunteer[] {
  const raw = readFileSync(new URL('../../seed/volunteers.json', import.meta.url), 'utf8');
  const entries = z.array(VolunteerSeedSchema).parse(JSON.parse(raw));
  return entries.map((v) => ({
    slack_user_id: v.slack_user_id,
    display_name: v.display_name,
    skills: [...v.skills],
    languages: [...v.languages],
    home_locality: resolveLocality(v.home_locality).localityId,
    radius_km: v.radius_km,
    capacity_per_day: v.capacity_per_day,
    availability: { ...v.availability },
    active_load: 0,
    is_demo: opts.isDemo ?? false,
  }));
}

/**
 * Load the gazetteer as scorer coordinates. Ids are the 1-based array index — the
 * SAME contract geocode.resolveLocality uses — so a resolved need locality and a
 * volunteer home locality line up on the same grid.
 */
export function loadLocalityCoords(): LocalityCoord[] {
  const raw = readFileSync(new URL('../../seed/localities.json', import.meta.url), 'utf8');
  const entries = z.array(LocalitySeedSchema).parse(JSON.parse(raw));
  return entries.map((e, i) => ({ id: i + 1, lat: e.lat, lng: e.lng }));
}

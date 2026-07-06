import { describe, expect, it } from 'vitest';
import {
  availabilityScore,
  haversineKm,
  type LocalityCoord,
  languageScore,
  type ScoreNeed,
  scoreVolunteers,
  skillScore,
  topN,
} from '../../src/match/scorer';
import type { Volunteer } from '../../src/match/volunteerStore';

// Deterministic scorer contract (BUILD-DOC §F3). The weighted sum, each component, and
// the ordering must be reproducible to the decimal — the LLM never ranks. Hand-built
// cases pin exact numbers; a haversine case pins the proximity decay.

const V = (over: Partial<Volunteer> & Pick<Volunteer, 'slack_user_id'>): Volunteer => ({
  display_name: over.slack_user_id,
  skills: [],
  languages: [],
  home_locality: null,
  radius_km: 5,
  capacity_per_day: 2,
  availability: {},
  active_load: 0,
  is_demo: false,
  ...over,
});

// Two localities 1° of longitude apart at the equator (~111.195 km).
const LOCALITIES: LocalityCoord[] = [
  { id: 1, lat: 0, lng: 0 },
  { id: 2, lat: 0, lng: 1 },
];

const MEDICAL_NEED: ScoreNeed = { type: 'medical', localityId: 1, languages: ['ta'] };

describe('component functions', () => {
  it('skillScore: direct match 1, adjacent 0.3, no skills 0, other accepts any', () => {
    expect(skillScore('medical', ['medical'])).toBe(1);
    expect(skillScore('rescue', ['driver'])).toBe(1); // driver satisfies rescue
    expect(skillScore('medical', ['driver'])).toBe(0.3); // has a skill, not the required one
    expect(skillScore('medical', [])).toBe(0);
    expect(skillScore('other', ['tech'])).toBe(1);
    expect(skillScore('other', [])).toBe(0);
  });

  it('languageScore: shared 1, disjoint 0, need without a language 1', () => {
    expect(languageScore(['ta'], ['ta', 'en'])).toBe(1);
    expect(languageScore(['ta'], ['en'])).toBe(0);
    expect(languageScore([], ['en'])).toBe(1);
  });

  it('availabilityScore: always 1, windowed 0.5, schedule by coverage', () => {
    expect(availabilityScore({})).toBe(1);
    expect(availabilityScore({ always: true })).toBe(1);
    expect(availabilityScore({ mode: 'always' })).toBe(1);
    expect(availabilityScore({ mode: 'daytime' })).toBe(0.5);
    expect(availabilityScore({ mode: 'evenings' })).toBe(0.5);
    expect(availabilityScore({ days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] })).toBe(1);
    expect(availabilityScore({ days: ['sat', 'sun'] })).toBe(0.5);
  });

  it('haversineKm: 1° of longitude at the equator ≈ 111.195 km', () => {
    expect(haversineKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
  });
});

describe('scoreVolunteers — exact weighted sums', () => {
  it('a perfect candidate (same locality, matching skill/language, idle, always free) scores 1.0', () => {
    const perfect = V({
      slack_user_id: 'V1',
      skills: ['medical'],
      languages: ['ta', 'en'],
      home_locality: 1,
      radius_km: 5,
      capacity_per_day: 4,
      active_load: 0,
      availability: { always: true },
    });
    const [c] = scoreVolunteers(MEDICAL_NEED, [perfect], LOCALITIES);
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.breakdown).toEqual({ skill: 1, proximity: 1, availability: 1, load: 1, language: 1 });
    expect(c.distanceKm).toBeCloseTo(0, 10);
    expect(c.score).toBeCloseTo(1, 10);
  });

  it('a weak candidate combines partial skill, neutral proximity, half load, off-hours, no language', () => {
    // skill 0.3, proximity 0.5 (unknown locality), availability 0.5, load 0.5, language 0
    // = 0.35*0.3 + 0.25*0.5 + 0.15*0.5 + 0.15*0.5 + 0.10*0 = 0.38
    const weak = V({
      slack_user_id: 'V2',
      skills: ['driver'],
      languages: ['en'],
      home_locality: null,
      capacity_per_day: 4,
      active_load: 2,
      availability: { mode: 'daytime' },
    });
    const [c] = scoreVolunteers(MEDICAL_NEED, [weak], LOCALITIES);
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.breakdown).toEqual({ skill: 0.3, proximity: 0.5, availability: 0.5, load: 0.5, language: 0 });
    expect(c.distanceKm).toBeNull();
    expect(c.score).toBeCloseTo(0.38, 10);
  });

  it('proximity decays as exp(-distance/radius) over real coordinates', () => {
    // distance ≈ 111.195 km, radius 100 → exp(-1.11195) ≈ 0.3289
    const far = V({
      slack_user_id: 'V3',
      skills: ['medical'],
      languages: ['ta'],
      home_locality: 2,
      radius_km: 100,
      capacity_per_day: 2,
      active_load: 0,
      availability: {},
    });
    const [c] = scoreVolunteers(MEDICAL_NEED, [far], LOCALITIES);
    expect(c).toBeDefined();
    if (!c) return;
    expect(c.distanceKm).toBeCloseTo(111.195, 2);
    expect(c.breakdown.proximity).toBeCloseTo(0.329, 3);
    // 0.35 + 0.25*0.3289 + 0.15 + 0.15 + 0.10 ≈ 0.8322
    expect(c.score).toBeCloseTo(0.8322, 3);
  });
});

describe('ordering + topN', () => {
  const perfect = V({
    slack_user_id: 'V1',
    skills: ['medical'],
    languages: ['ta', 'en'],
    home_locality: 1,
    radius_km: 5,
    capacity_per_day: 4,
    availability: { always: true },
  });
  const far = V({
    slack_user_id: 'V3',
    skills: ['medical'],
    languages: ['ta'],
    home_locality: 2,
    radius_km: 100,
  });
  const weak = V({
    slack_user_id: 'V2',
    skills: ['driver'],
    languages: ['en'],
    capacity_per_day: 4,
    active_load: 2,
    availability: { mode: 'daytime' },
  });

  it('sorts highest-first regardless of input order', () => {
    const ranked = scoreVolunteers(MEDICAL_NEED, [weak, far, perfect], LOCALITIES);
    expect(ranked.map((c) => c.volunteer.slack_user_id)).toEqual(['V1', 'V3', 'V2']);
  });

  it('topN slices the ranking (default 3)', () => {
    const all = topN(MEDICAL_NEED, [weak, far, perfect], LOCALITIES);
    expect(all.map((c) => c.volunteer.slack_user_id)).toEqual(['V1', 'V3', 'V2']);
    expect(topN(MEDICAL_NEED, [weak, far, perfect], LOCALITIES, 1).map((c) => c.volunteer.slack_user_id)).toEqual([
      'V1',
    ]);
    expect(topN(MEDICAL_NEED, [weak, far, perfect], LOCALITIES, 2).map((c) => c.volunteer.slack_user_id)).toEqual([
      'V1',
      'V3',
    ]);
  });

  it('breaks ties deterministically by slack_user_id', () => {
    // Identical scoring inputs, unknown locality (distance null) → tie broken by id asc.
    const z = V({ slack_user_id: 'V_Z', skills: ['medical'], languages: ['ta'], home_locality: null });
    const a = V({ slack_user_id: 'V_A', skills: ['medical'], languages: ['ta'], home_locality: null });
    const ranked = scoreVolunteers(MEDICAL_NEED, [z, a], LOCALITIES);
    expect(ranked[0]?.score).toBeCloseTo(ranked[1]?.score ?? -1, 10);
    expect(ranked.map((c) => c.volunteer.slack_user_id)).toEqual(['V_A', 'V_Z']);
  });
});

describe('weight overrides', () => {
  it('opts.weights lets the integrator retune without changing the math', () => {
    const perfect = V({ slack_user_id: 'V1', skills: ['medical'], languages: ['ta'], home_locality: 1 });
    const weak = V({ slack_user_id: 'V2', skills: ['driver'], languages: ['ta'], home_locality: 1 });
    // Put ALL weight on skill → the score IS the skill component.
    const w = { skill: 1, proximity: 0, availability: 0, load: 0, language: 0 };
    const ranked = scoreVolunteers(MEDICAL_NEED, [weak, perfect], LOCALITIES, { weights: w });
    expect(ranked[0]?.score).toBeCloseTo(1, 10);
    expect(ranked[1]?.score).toBeCloseTo(0.3, 10);
  });
});

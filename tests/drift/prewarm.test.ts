import { describe, expect, it } from 'vitest';
import { type BackupNeed, computeBackup } from '../../src/drift/prewarm';
import type { LocalityCoord } from '../../src/match/scorer';
import type { Volunteer } from '../../src/match/volunteerStore';

// computeBackup — the pre-warmed backup is a REAL scored candidate (the #1 alternative from the
// SAME deterministic scorer, current assignee excluded), never theater.

function vol(id: string, skills: string[], extra: Partial<Volunteer> = {}): Volunteer {
  return {
    slack_user_id: id,
    display_name: `Vol ${id}`,
    skills,
    languages: ['en'],
    home_locality: null,
    radius_km: 5,
    capacity_per_day: 3,
    availability: {},
    active_load: 0,
    is_demo: true,
    ...extra,
  };
}

const NO_LOCALITIES: LocalityCoord[] = [];
const foodNeed = (assignee: string | null): BackupNeed => ({
  type: 'food',
  localityId: null,
  languages: [],
  assignedVolunteerId: assignee,
});

describe('computeBackup', () => {
  it('returns null when the roster is empty', () => {
    expect(computeBackup(foodNeed(null), [], NO_LOCALITIES)).toBeNull();
  });

  it('returns null when the only volunteer is the current assignee', () => {
    const only = vol('V1', ['cooking']);
    expect(computeBackup(foodNeed('V1'), [only], NO_LOCALITIES)).toBeNull();
  });

  it('excludes the current assignee and returns the best remaining candidate', () => {
    const roster = [vol('V1', ['cooking']), vol('V2', ['cooking']), vol('V3', [])];
    const backup = computeBackup(foodNeed('V1'), roster, NO_LOCALITIES);
    expect(backup).not.toBeNull();
    expect(backup?.volunteer.slack_user_id).not.toBe('V1');
    // V2 (cooking) outscores V3 (no matching skill) → V2 is the backup.
    expect(backup?.volunteer.slack_user_id).toBe('V2');
  });

  it('returns a genuine scored candidate (positive score + breakdown)', () => {
    const roster = [vol('V1', ['cooking']), vol('V2', ['cooking'])];
    const backup = computeBackup(foodNeed('V1'), roster, NO_LOCALITIES);
    expect(backup?.score).toBeGreaterThan(0);
    expect(backup?.breakdown.skill).toBe(1); // cooking satisfies a food need
  });

  it('with no assignee, returns the overall top candidate', () => {
    const roster = [vol('V3', []), vol('V1', ['cooking'])];
    const backup = computeBackup(foodNeed(null), roster, NO_LOCALITIES);
    expect(backup?.volunteer.slack_user_id).toBe('V1');
  });

  it('is deterministic — same inputs yield the same backup', () => {
    const roster = [vol('V1', ['cooking']), vol('V2', ['cooking', 'driver']), vol('V3', ['driver'])];
    const a = computeBackup(foodNeed('V1'), roster, NO_LOCALITIES);
    const b = computeBackup(foodNeed('V1'), roster, NO_LOCALITIES);
    expect(a?.volunteer.slack_user_id).toBe(b?.volunteer.slack_user_id);
    expect(a?.score).toBe(b?.score);
  });
});

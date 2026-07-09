import { describe, expect, it } from 'vitest';
import type { BackupCandidate } from '../../src/drift/prewarm';
import { emptyFlags, type NeedFlags, type NeedState, type ProjectedNeed } from '../../src/ledger/types';
import type { Volunteer } from '../../src/match/volunteerStore';
import { dispatchCard } from '../../src/surfaces/needCard';
import type { SlackBlock } from '../../src/surfaces/primitives';

// The pre-warmed backup chip on the dispatch card (Moonshot). It renders ONLY for a live obligation
// (CLAIMED/IN_PROGRESS with an assignee) when a backup is injected, names the backup by first name +
// match %, and is PII-free. Without a backup, or on a non-delivering state, no chip appears.

function backupVol(displayName: string): Volunteer {
  return {
    slack_user_id: 'V_BACKUP',
    display_name: displayName,
    skills: ['cooking'],
    languages: ['en'],
    home_locality: null,
    radius_km: 5,
    capacity_per_day: 3,
    availability: {},
    active_load: 0,
    is_demo: true,
  };
}

function backup(displayName = 'Meena Raghavan'): BackupCandidate {
  return {
    volunteer: backupVol(displayName),
    score: 0.62,
    distanceKm: null,
    breakdown: { skill: 1, proximity: 0.5, availability: 1, load: 1, language: 1 },
  };
}

function need(state: NeedState, flags: Partial<NeedFlags> = {}): ProjectedNeed {
  return {
    need_id: 'need-1',
    state,
    type: 'food',
    severity: 'high',
    locality_id: 1,
    location_text: 'Velachery',
    people_count: 3,
    languages: ['en'],
    source: { permalink: 'https://relay.demo/x' },
    confidence: { type: 'stated', severity: 'stated' },
    merged_into: null,
    assigned_volunteer_id: 'V_ASSIGNEE',
    obligation_id: 'ob-1',
    sla_due_at: '2026-07-04T01:00:00.000Z',
    evidence: [],
    flags: { ...emptyFlags(), ...flags },
    state_version: 1,
    history_count: 5,
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:10:00.000Z',
  };
}

const jsonOf = (blocks: SlackBlock[]): string => JSON.stringify(blocks);

describe('dispatch card — pre-warmed backup chip', () => {
  it('renders the standby chip on a CLAIMED need with a backup, naming the first name + match %', () => {
    const dump = jsonOf(dispatchCard('N-0002', need('CLAIMED'), { backup: backup('Meena Raghavan') }));
    expect(dump).toContain('Backup pre-warmed');
    expect(dump).toContain('Meena'); // first name only
    expect(dump).not.toContain('Raghavan'); // surname is not rendered
    expect(dump).toContain('62%'); // match score
  });

  it('shows the at-risk variant when the obligation is at risk', () => {
    const dump = jsonOf(dispatchCard('N-0002', need('CLAIMED', { is_at_risk: true }), { backup: backup() }));
    expect(dump).toContain('ready to take over');
  });

  it('renders NO chip when no backup is injected', () => {
    const dump = jsonOf(dispatchCard('N-0002', need('CLAIMED')));
    expect(dump).not.toContain('Backup pre-warmed');
  });

  it('renders NO chip on a pre-commit (OPEN) need even with a backup', () => {
    const open = need('OPEN');
    open.assigned_volunteer_id = null;
    const dump = jsonOf(dispatchCard('N-0002', open, { backup: backup() }));
    expect(dump).not.toContain('Backup pre-warmed');
  });

  it('renders NO chip once the need is CLOSED', () => {
    const dump = jsonOf(dispatchCard('N-0002', need('CLOSED'), { backup: backup() }));
    expect(dump).not.toContain('Backup pre-warmed');
  });

  it('the chip is PII-free — no phone-length digit run', () => {
    const dump = jsonOf(dispatchCard('N-0002', need('IN_PROGRESS'), { backup: backup() }));
    expect(dump).toContain('Backup pre-warmed');
    // the chip carries only a first name + a small percentage — never a contact number.
    const chip = dump.slice(dump.indexOf('Backup pre-warmed'));
    expect(/\d{7,}/.test(chip.slice(0, 120))).toBe(false);
  });
});

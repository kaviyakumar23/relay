import { describe, expect, it } from 'vitest';
import { FLOOR_KEYWORDS as EVAL_FLOOR_KEYWORDS } from '../../eval/score';
import type { Severity } from '../../src/ledger/types';
import { FLOOR_KEYWORDS, floorSeverity, hasFloorKeyword } from '../../src/pipeline/severityFloor';

describe('hasFloorKeyword', () => {
  it('fires on floor keywords case-insensitively', () => {
    expect(hasFloorKeyword('uncle needs DIALYSIS tomorrow')).toBe(true);
    expect(hasFloorKeyword('A child got swept into the water')).toBe(true);
    expect(hasFloorKeyword('grandfather on oxygen, cylinder low')).toBe(true);
    expect(hasFloorKeyword('man with chest pain, no ambulance')).toBe(true);
    expect(hasFloorKeyword('family trapped on the rooftop')).toBe(true);
  });

  it('does not fire on non-floor need language', () => {
    expect(hasFloorKeyword('three families need food, water is rising')).toBe(false);
    expect(hasFloorKeyword('elderly couple surrounded by water, help')).toBe(false);
    expect(hasFloorKeyword('need a vehicle to move 6 people')).toBe(false);
  });
});

describe('floorSeverity — only raises, never lowers', () => {
  it('forces critical when a floor keyword is present, regardless of extracted', () => {
    for (const extracted of ['low', 'medium', 'high', 'critical'] as Severity[]) {
      expect(floorSeverity('patient trapped in a flooded house', extracted)).toBe('critical');
    }
  });

  it('returns the extracted severity unchanged when no floor keyword is present', () => {
    expect(floorSeverity('need food packets for a family', 'low')).toBe('low');
    expect(floorSeverity('need food packets for a family', 'medium')).toBe('medium');
    expect(floorSeverity('need food packets for a family', 'high')).toBe('high');
    expect(floorSeverity('need food packets for a family', 'critical')).toBe('critical');
  });

  it('never returns a severity below the extracted one', () => {
    const rank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
    const texts = ['baby not breathing', 'no drinking water for two days', 'anyone have a helpline list'];
    for (const text of texts) {
      for (const extracted of ['low', 'medium', 'high', 'critical'] as Severity[]) {
        expect(rank[floorSeverity(text, extracted)]).toBeGreaterThanOrEqual(rank[extracted]);
      }
    }
  });
});

describe('FLOOR_KEYWORDS — single source of truth', () => {
  it('is a non-empty list including the canonical keywords', () => {
    expect(FLOOR_KEYWORDS.length).toBeGreaterThan(0);
    expect(FLOOR_KEYWORDS).toContain('trapped');
    expect(FLOOR_KEYWORDS).toContain('dialysis');
  });

  it('is byte-identical to the list eval/score re-exports (gold labels stay consistent)', () => {
    expect([...EVAL_FLOOR_KEYWORDS]).toEqual([...FLOOR_KEYWORDS]);
  });
});

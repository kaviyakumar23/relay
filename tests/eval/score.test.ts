import { describe, expect, it } from 'vitest';
import {
  aggregate,
  type EvalResult,
  FLOOR_KEYWORDS,
  hitsCriticalFloor,
  normalizeContact,
  normalizeLocality,
  scoreCase,
} from '../../eval/score';
import type { NeedDraft } from '../../src/llm/needDraft';

// A fully-populated gold NeedDraft; override per test. Provenance carries all six
// canonical fields the scorer inspects.
function draft(overrides: Partial<NeedDraft> = {}): NeedDraft {
  return {
    type: 'food',
    severity: 'high',
    locality_guess: 'Velachery',
    location_text: 'on a terrace',
    people_count: 3,
    contact_raw: '+91 98400 05678',
    summary_en: 'three families need food',
    languages: ['en'],
    provenance: {
      type: { status: 'stated' },
      severity: { status: 'inferred', why: 'urgent phrasing' },
      locality_guess: { status: 'stated' },
      location_text: { status: 'stated' },
      people_count: { status: 'inferred', why: '3 families' },
      contact_raw: { status: 'stated' },
    },
    ...overrides,
  };
}

const result = (id: string, language: EvalResult['language'], score: EvalResult['score']): EvalResult => ({
  id,
  language,
  score,
});

describe('scoreCase — exact match', () => {
  it('marks every field and provenance status correct', () => {
    const s = scoreCase(draft(), draft());
    expect(s.needsReview).toBe(false);
    expect(s.fields).toEqual({
      type: true,
      severity: true,
      locality_guess: true,
      people_count: true,
      contact_raw: true,
    });
    expect(Object.values(s.provenance).every(Boolean)).toBe(true);
  });

  it('aggregates to 100% overall field accuracy', () => {
    const agg = aggregate([result('E01', 'en', scoreCase(draft(), draft()))]);
    expect(agg.fieldAccuracy.overall).toBe(1);
    expect(agg.attempted).toBe(1);
    expect(agg.needsReviewRate).toBe(0);
  });
});

describe('scoreCase — severity miss', () => {
  it('fails only the severity field; provenance compares status not value', () => {
    const gold = draft({ severity: 'critical' });
    const predicted = draft({ severity: 'high' }); // wrong value, same 'inferred' status
    const s = scoreCase(gold, predicted);
    expect(s.fields.severity).toBe(false);
    expect(s.fields.type).toBe(true);
    // Both label severity provenance 'inferred', so the provenance status still matches.
    expect(s.provenance.severity).toBe(true);
  });
});

describe('scoreCase — people_count exact-or-null', () => {
  it('both null → correct', () => {
    expect(scoreCase(draft({ people_count: null }), draft({ people_count: null })).fields.people_count).toBe(true);
  });
  it('one null → incorrect', () => {
    expect(scoreCase(draft({ people_count: null }), draft({ people_count: 3 })).fields.people_count).toBe(false);
    expect(scoreCase(draft({ people_count: 3 }), draft({ people_count: null })).fields.people_count).toBe(false);
  });
  it('different numbers → incorrect', () => {
    expect(scoreCase(draft({ people_count: 3 }), draft({ people_count: 4 })).fields.people_count).toBe(false);
  });
});

describe('scoreCase — provenance status', () => {
  it('flags a changed provenance status as wrong for that field only', () => {
    const gold = draft();
    const predicted = draft({
      provenance: { ...draft().provenance, type: { status: 'inferred' } }, // gold said 'stated'
    });
    const s = scoreCase(gold, predicted);
    expect(s.provenance.type).toBe(false);
    expect(s.provenance.severity).toBe(true);
  });
});

describe('normalizeContact', () => {
  it('matches across spaces, dashes and +91 country code', () => {
    expect(normalizeContact('+91 98400 05678')).toBe('9840005678');
    expect(normalizeContact('98400-05678')).toBe('9840005678');
    expect(normalizeContact('098400 05678')).toBe('9840005678');
    expect(normalizeContact('9840005678')).toBe('9840005678');
  });
  it('null in → null out', () => {
    expect(normalizeContact(null)).toBeNull();
    expect(normalizeContact('no digits here')).toBeNull();
  });
  it('scores a spaced/country-coded contact as a match', () => {
    const s = scoreCase(draft({ contact_raw: '+91 98400 05678' }), draft({ contact_raw: '98400-05678' }));
    expect(s.fields.contact_raw).toBe(true);
  });
  it('scores both-null contacts as a match', () => {
    expect(scoreCase(draft({ contact_raw: null }), draft({ contact_raw: null })).fields.contact_raw).toBe(true);
  });
});

describe('normalizeLocality', () => {
  it('is case-insensitive', () => {
    expect(normalizeLocality('VELACHERY')).toBe('velachery');
  });
  it('resolves aliases to canonical', () => {
    expect(normalizeLocality('Bessie')).toBe('besant nagar');
    expect(normalizeLocality('Tiruvanmiyur')).toBe('thiruvanmiyur');
  });
  it('scores an alias against the canonical gold as a match', () => {
    expect(
      scoreCase(draft({ locality_guess: 'Besant Nagar' }), draft({ locality_guess: 'Bessie' })).fields.locality_guess,
    ).toBe(true);
    expect(
      scoreCase(draft({ locality_guess: 'Thiruvanmiyur' }), draft({ locality_guess: 'Tiruvanmiyur' })).fields
        .locality_guess,
    ).toBe(true);
  });
  it('scores both-null localities as a match and one-null as a miss', () => {
    expect(scoreCase(draft({ locality_guess: null }), draft({ locality_guess: null })).fields.locality_guess).toBe(
      true,
    );
    expect(
      scoreCase(draft({ locality_guess: 'Velachery' }), draft({ locality_guess: null })).fields.locality_guess,
    ).toBe(false);
  });
});

describe('aggregate — critical recall & precision math', () => {
  it('computes recall 2/3 and precision 2/3', () => {
    const goldCrit = draft({ severity: 'critical' });
    const goldHigh = draft({ severity: 'high' });
    const results: EvalResult[] = [
      result('E1', 'en', scoreCase(goldCrit, draft({ severity: 'critical' }))), // TP
      result('E2', 'en', scoreCase(goldCrit, draft({ severity: 'critical' }))), // TP
      result('E3', 'en', scoreCase(goldCrit, draft({ severity: 'high' }))), // FN (missed critical)
      result('E4', 'en', scoreCase(goldHigh, draft({ severity: 'critical' }))), // FP (over-escalated)
    ];
    const agg = aggregate(results);
    expect(agg.criticalRecall).toBeCloseTo(2 / 3, 10); // 2 of 3 gold-critical caught
    expect(agg.criticalPrecision).toBeCloseTo(2 / 3, 10); // 2 of 3 predicted-critical were right
  });

  it('returns vacuous 1.0 precision when nothing is predicted critical', () => {
    const agg = aggregate([result('E1', 'en', scoreCase(draft({ severity: 'high' }), draft({ severity: 'high' })))]);
    expect(agg.criticalPrecision).toBe(1);
    expect(agg.criticalRecall).toBe(0); // no gold criticals present
  });
});

describe('aggregate — needs-review handling', () => {
  it('counts a null prediction as needs-review and, for gold-critical, a recall miss', () => {
    const s = scoreCase(draft({ severity: 'critical' }), null);
    expect(s.needsReview).toBe(true);
    expect(s.predictedSeverity).toBeNull();
    expect(Object.values(s.fields).every((v) => v === false)).toBe(true);
    expect(Object.values(s.provenance).every((v) => v === false)).toBe(true);

    const agg = aggregate([result('E01', 'en', s)]);
    expect(agg.needsReviewRate).toBe(1);
    expect(agg.attempted).toBe(0);
    expect(agg.criticalRecall).toBe(0); // punted gold-critical is not auto-detected
    expect(agg.fieldAccuracy.overall).toBe(0); // no attempted extractions to average
  });

  it('excludes needs-review cases from field-accuracy denominator', () => {
    const results: EvalResult[] = [
      result('E01', 'en', scoreCase(draft(), draft())), // perfect, attempted
      result('E02', 'en', scoreCase(draft(), null)), // punted
    ];
    const agg = aggregate(results);
    expect(agg.attempted).toBe(1);
    expect(agg.needsReviewRate).toBe(0.5);
    expect(agg.fieldAccuracy.overall).toBe(1); // averaged over the one attempt only
  });
});

describe('aggregate — per-language breakdown', () => {
  it('splits accuracy by language tag', () => {
    const results: EvalResult[] = [
      result('E01', 'en', scoreCase(draft(), draft())),
      result('E25', 'ta-en', scoreCase(draft({ severity: 'critical' }), draft({ severity: 'high' }))),
    ];
    const agg = aggregate(results);
    expect(agg.perLanguage.en?.n).toBe(1);
    expect(agg.perLanguage.en?.fieldAccuracy).toBe(1);
    expect(agg.perLanguage['ta-en']?.n).toBe(1);
    // ta-en case missed severity → below 1.0 but not zero.
    expect(agg.perLanguage['ta-en']?.fieldAccuracy).toBeLessThan(1);
    expect(agg.perLanguage['ta-en']?.criticalRecall).toBe(0);
  });
});

describe('hitsCriticalFloor', () => {
  it('detects floor keywords', () => {
    expect(hitsCriticalFloor('A child got swept into the water')).toBe(true);
    expect(hitsCriticalFloor('grandfather on oxygen, cylinder low')).toBe(true);
    expect(hitsCriticalFloor('uncle needs DIALYSIS tomorrow')).toBe(true);
  });
  it('does not fire on non-floor need language', () => {
    expect(hitsCriticalFloor('three families need food, water is rising')).toBe(false);
    expect(hitsCriticalFloor('elderly couple surrounded by water, help')).toBe(false);
  });
  it('exposes a non-empty keyword list', () => {
    expect(FLOOR_KEYWORDS.length).toBeGreaterThan(0);
  });
});

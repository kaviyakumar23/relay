import { describe, expect, it } from 'vitest';
import { NeedDraftSchema } from '../../src/llm/needDraft';
import { normalizeContact } from '../../src/pipeline/contact';
import { heuristicNeedDraft } from '../../src/pipeline/heuristicExtractor';

// Every heuristic output must be indistinguishable from a validated LLM response, so each
// assertion first re-parses the draft through NeedDraftSchema (the real boundary).
function extract(text: string) {
  const draft = heuristicNeedDraft(text);
  expect(() => NeedDraftSchema.parse(draft)).not.toThrow();
  return draft;
}

describe('heuristicNeedDraft — medical / critical via floor', () => {
  it('classifies a dialysis message as medical and floors severity to critical', () => {
    const d = extract(
      "My uncle needs dialysis tomorrow morning, he's stuck near the old bridge, water is till knee height.",
    );
    expect(d.type).toBe('medical');
    expect(d.severity).toBe('critical');
    expect(d.people_count).toBe(1); // "my uncle" → one person, inferred
    expect(d.provenance.people_count?.status).toBe('inferred');
    expect(d.contact_raw).toBeNull();
    expect(d.locality_guess).toBeNull(); // landmark only, no gazetteer match
    expect(d.languages).toEqual(['en']);
  });

  it('floors a rescue message with a trapped keyword to critical', () => {
    const d = extract(
      'Family trapped on the rooftop in Pallikaranai, water rising fast, 5 people including an old man.',
    );
    expect(d.type).toBe('rescue');
    expect(d.severity).toBe('critical');
    expect(d.locality_guess).toBe('Pallikaranai');
    expect(d.people_count).toBe(5);
    expect(d.provenance.people_count?.status).toBe('stated'); // explicit "5 people"
    expect(d.contact_raw).toBeNull();
  });
});

describe('heuristicNeedDraft — Tamil-English code-mix food case', () => {
  it('extracts type/severity/locality/count/contact/language from an E25-style message', () => {
    const d = extract(
      'Velachery la 3 families terrace mela irukanga, thanni yeruthu, food venum romba urgent. +91 98400 05678 anna number',
    );
    expect(d.type).toBe('food');
    expect(d.severity).toBe('high'); // "romba urgent"
    expect(d.locality_guess).toBe('Velachery');
    expect(d.people_count).toBe(3);
    expect(d.provenance.people_count?.status).toBe('inferred'); // "3 families" → households
    expect(d.contact_raw).not.toBeNull();
    expect(normalizeContact(d.contact_raw)?.digits).toBe('9840005678');
    expect(d.languages).toContain('ta');
    expect(d.languages).toContain('en');
  });
});

describe('heuristicNeedDraft — water and other', () => {
  it('classifies a drinking-water shortage (with an incidental "shelter" mention) as water', () => {
    const d = extract(
      'No drinking water for two days at the Perungudi relief shelter, around 40 people including elderly.',
    );
    expect(d.type).toBe('water');
    expect(d.locality_guess).toBe('Perungudi');
    expect(d.people_count).toBe(40);
  });

  it('falls back to other + low for an informational query', () => {
    const d = extract(
      'Does anyone have a list of helpline numbers for the flood relief? Sharing with our building group.',
    );
    expect(d.type).toBe('other');
    expect(d.severity).toBe('low');
    expect(d.contact_raw).toBeNull(); // "helpline numbers" is not a phone number
  });
});

describe('heuristicNeedDraft — count from "couple"', () => {
  it('reads an elderly couple as two people (inferred), not "couple of nights"', () => {
    const d = extract(
      'Elderly couple stranded by rising water near the Kotturpuram park, they need to be moved, anyone nearby?',
    );
    expect(d.type).toBe('rescue');
    expect(d.locality_guess).toBe('Kotturpuram');
    expect(d.people_count).toBe(2);
    expect(d.provenance.people_count?.status).toBe('inferred');
  });
});

describe('heuristicNeedDraft — summary is derived, never raw', () => {
  it('produces a non-empty derived summary that is not the raw message', () => {
    const raw = 'Three families are on a terrace in Velachery, water is rising and they need food urgently.';
    const d = extract(raw);
    expect(d.summary_en.length).toBeGreaterThan(0);
    expect(d.summary_en).not.toBe(raw);
  });
});

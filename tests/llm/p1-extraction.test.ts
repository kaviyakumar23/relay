import { describe, expect, it } from 'vitest';
import { MockLlm } from '../../src/llm/mock';
import { NeedDraftSchema } from '../../src/llm/needDraft';
import { buildExtractionRequest, P1_EXTRACTION_SYSTEM } from '../../src/llm/prompts/p1-extraction';

describe('P-1 intake-extraction request builder', () => {
  it('returns a well-formed ParseRequest bound to NeedDraftSchema', () => {
    const req = buildExtractionRequest('Family trapped on a Pallikaranai rooftop, water rising.');
    expect(req.task).toBe('extract');
    expect(req.schemaName).toBe('NeedDraft');
    expect(req.schema).toBe(NeedDraftSchema);
    expect(req.maxTokens).toBe(1024);
    expect(req.system.length).toBeGreaterThan(0);
    expect(req.user.length).toBeGreaterThan(0);
  });

  it('passes the message text through verbatim as `user` (transient), not in `system`', () => {
    const text = 'Velachery la 3 families terrace mela irukanga, food venum urgent';
    const req = buildExtractionRequest(text);
    expect(req.user).toBe(text);
    // The system prompt is static instruction, independent of the per-message text.
    expect(req.system).toBe(P1_EXTRACTION_SYSTEM);
    expect(req.system).not.toContain(text);
  });

  it('teaches the code-mix + critical-floor + privacy contract in the system prompt', () => {
    expect(P1_EXTRACTION_SYSTEM).toContain('Tamil-English');
    expect(P1_EXTRACTION_SYSTEM).toContain('HIGHER');
    expect(P1_EXTRACTION_SYSTEM).toContain('dialysis');
    // summary_en must be a paraphrase, and contact detail must not leak into it.
    expect(P1_EXTRACTION_SYSTEM).toContain('contact_raw');
  });

  it('carries a NeedDraft-valid response through the same Zod boundary as the real providers', async () => {
    const llm = new MockLlm(() => ({
      type: 'rescue',
      severity: 'critical',
      locality_guess: 'Pallikaranai',
      location_text: null,
      people_count: 5,
      contact_raw: null,
      summary_en: 'Five people trapped on a Pallikaranai rooftop as water rises.',
      languages: ['en'],
      provenance: {
        type: { status: 'inferred', why: 'trapped by rising water implies rescue' },
        severity: { status: 'inferred', why: "critical: 'trapped' keyword floor" },
      },
    }));
    const out = await llm.parse(buildExtractionRequest('Family trapped on a Pallikaranai rooftop.'));
    expect(NeedDraftSchema.safeParse(out).success).toBe(true);
    expect(out.severity).toBe('critical');
  });
});

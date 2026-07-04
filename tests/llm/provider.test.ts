import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLlm } from '../../src/llm/mock';
import { LlmParseError, type ParseRequest } from '../../src/llm/provider';

const Schema = z.object({ type: z.string(), n: z.number().nullable() });
const req = (over: Partial<ParseRequest<typeof Schema>> = {}): ParseRequest<typeof Schema> => ({
  task: 'extract',
  system: 'sys',
  user: 'usr',
  schema: Schema,
  schemaName: 'TestOut',
  ...over,
});

describe('LLM provider seam (mock through the real Zod boundary)', () => {
  it('returns validated output on a good first response', async () => {
    const llm = new MockLlm(() => ({ type: 'food', n: 3 }));
    const out = await llm.parse(req());
    expect(out).toEqual({ type: 'food', n: 3 });
    expect(llm.callCount).toBe(1);
  });

  it('repairs once when the first response is invalid', async () => {
    // First return violates schema (n is a string), second is valid.
    const llm = new MockLlm(() => [
      { type: 'food', n: 'oops' },
      { type: 'food', n: 3 },
    ]);
    const out = await llm.parse(req());
    expect(out).toEqual({ type: 'food', n: 3 });
    expect(llm.callCount).toBe(2);
  });

  it('throws LlmParseError after two failures (caller maps to NEEDS_REVIEW)', async () => {
    const llm = new MockLlm(() => ({ type: 'food' })); // missing required `n`
    await expect(llm.parse(req())).rejects.toBeInstanceOf(LlmParseError);
    expect(llm.callCount).toBe(2); // initial + one repair, then give up
  });

  it('accepts null for nullable fields', async () => {
    const llm = new MockLlm(() => ({ type: 'rescue', n: null }));
    await expect(llm.parse(req())).resolves.toEqual({ type: 'rescue', n: null });
  });
});

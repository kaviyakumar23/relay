import type { z } from 'zod';
import { LlmParseError } from './provider';

// Uniform reliability pattern (BUILD-DOC §10.2): validate against the Zod schema;
// on failure, run exactly ONE repair pass with the validation error appended to
// the prompt; on a second failure, throw LlmParseError (caller → NEEDS_REVIEW).
//
// `callModel(repairHint)` performs one model round-trip returning the raw JSON the
// model produced (already extracted from the tool call). Kept provider-neutral so
// both OpenAI and Anthropic reuse it.

export async function parseWithRepair<T extends z.ZodType>(
  schema: T,
  schemaName: string,
  callModel: (repairHint: string | null) => Promise<unknown>,
): Promise<z.infer<T>> {
  const first = await callModel(null);
  const firstResult = schema.safeParse(first);
  if (firstResult.success) return firstResult.data;

  const hint =
    `Your previous response failed validation for schema ${schemaName}:\n` +
    `${JSON.stringify(firstResult.error.issues)}\n` +
    'Return corrected JSON that satisfies the schema exactly.';

  const second = await callModel(hint);
  const secondResult = schema.safeParse(second);
  if (secondResult.success) return secondResult.data;

  throw new LlmParseError(schemaName, JSON.stringify(secondResult.error.issues));
}

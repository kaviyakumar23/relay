import type { z } from 'zod';
import { config } from '../config';
import { AnthropicProvider } from './anthropic';
import type { LlmTask } from './models';
import { modelFor } from './models';
import { OpenAiProvider } from './openai';

// Provider-agnostic LLM seam (kept/inview DNA). Callers describe WHAT they want
// (a system+user prompt and a Zod schema); the provider forces structured output
// and validates at the boundary. The LLM proposes; deterministic code decides.
// Swap providers with one env var (LLM_PROVIDER) — the core pipeline never learns
// which vendor answered.

export interface ParseRequest<T extends z.ZodType> {
  task: LlmTask;
  system: string;
  user: string;
  schema: T;
  schemaName: string;
  maxTokens?: number;
}

export interface LlmProvider {
  /** Force a schema-valid structured response, or throw LlmParseError after a repair pass. */
  parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<z.infer<T>>;
  readonly name: 'openai' | 'anthropic' | 'mock';
}

/** Thrown when the model can't produce schema-valid output even after one repair
 * pass. Callers map this to NEEDS_REVIEW + a human card — never a guess (§10.2). */
export class LlmParseError extends Error {
  constructor(
    public readonly schemaName: string,
    public readonly detail: string,
  ) {
    super(`LLM output failed schema ${schemaName} after repair: ${detail}`);
    this.name = 'LlmParseError';
  }
}

/** Refusal / safety stop from the model — surfaced distinctly from a parse failure. */
export class LlmRefusalError extends Error {
  constructor(public readonly reason: string) {
    super(`LLM refused: ${reason}`);
    this.name = 'LlmRefusalError';
  }
}

export function createLlm(): LlmProvider {
  if (config.llmProvider === 'anthropic') {
    if (!config.anthropicApiKey) throw new Error('LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset');
    return new AnthropicProvider(config.anthropicApiKey);
  }
  if (!config.openaiApiKey) throw new Error('LLM_PROVIDER=openai but OPENAI_API_KEY is unset');
  return new OpenAiProvider(config.openaiApiKey);
}

export { modelFor };

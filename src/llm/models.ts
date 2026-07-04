// Per-task model tiers, provider-agnostic (BUILD-DOC §10.1). A task maps to a
// 'quality' or 'cheap' tier; each provider resolves the tier to a concrete model.
// Override any concrete id via env (LLM_MODEL_QUALITY / LLM_MODEL_CHEAP).

export type ModelTier = 'quality' | 'cheap';

// P-1 extraction, P-5 sitrep, P-6 report, P-7 ask-relay → quality.
// P-2 splitter, P-3 dedupe-adjudication, P-4 match-rationale → cheap.
export const TASK_TIER = {
  extract: 'quality',
  splitter: 'cheap',
  dedupe: 'cheap',
  matchRationale: 'cheap',
  sitrep: 'quality',
  report: 'quality',
  askRelay: 'quality',
} as const satisfies Record<string, ModelTier>;

export type LlmTask = keyof typeof TASK_TIER;

const env = process.env;

export const PROVIDER_MODELS = {
  openai: {
    quality: env.LLM_MODEL_QUALITY ?? 'gpt-4o',
    cheap: env.LLM_MODEL_CHEAP ?? 'gpt-4o-mini',
  },
  anthropic: {
    quality: env.LLM_MODEL_QUALITY ?? 'claude-sonnet-4-6',
    cheap: env.LLM_MODEL_CHEAP ?? 'claude-haiku-4-5',
  },
} as const;

export function modelFor(provider: 'openai' | 'anthropic', task: LlmTask): string {
  return PROVIDER_MODELS[provider][TASK_TIER[task]];
}

import type { Severity } from '../ledger/types';

// Deterministic severity floor (CLAUDE.md invariant 4 / BUILD-DOC §11.2). Certain
// keywords force severity=critical and NO model may ever lower them. This module is
// the single runtime source of truth for that list: it lives under src/ (not eval/)
// because Docker excludes eval/ (.dockerignore) and runtime code must never import
// across that boundary. eval/score.ts re-exports FLOOR_KEYWORDS/hasFloorKeyword from
// here so the gold-set justification and the runtime extractor stay byte-identical.
//
// FLOOR KEYWORDS (case-insensitive substring match):
//   trapped · drowning · dialysis · oxygen · chest pain · unconscious ·
//   not breathing · cardiac · heart attack · seizure · bleeding ·
//   child · children · baby · infant · newborn · in labour · in labor
export const FLOOR_KEYWORDS: readonly string[] = [
  'trapped',
  'drowning',
  'dialysis',
  'oxygen',
  'chest pain',
  'unconscious',
  'not breathing',
  'cardiac',
  'heart attack',
  'seizure',
  'bleeding',
  'child',
  'children',
  'baby',
  'infant',
  'newborn',
  'in labour',
  'in labor',
];

/** True when a message contains a deterministic critical-floor keyword. */
export function hasFloorKeyword(text: string): boolean {
  const t = text.toLowerCase();
  return FLOOR_KEYWORDS.some((k) => t.includes(k));
}

/**
 * Apply the deterministic floor to an extracted severity. The floor only ever RAISES:
 * a floor keyword forces 'critical' (the maximum), otherwise the extracted severity is
 * returned unchanged. It can never return something lower than `extracted`.
 */
export function floorSeverity(text: string, extracted: Severity): Severity {
  return hasFloorKeyword(text) ? 'critical' : extracted;
}

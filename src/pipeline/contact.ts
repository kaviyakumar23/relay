// Indian-mobile-aware contact normalization (donor gap fixed here — see CLAUDE.md reuse
// note "Indian mobile detection"). PURE: this module only NORMALIZES a candidate contact
// string to canonical digits + a display form. It NEVER logs, persists, or vaults — the
// caller decides to route the value into the encrypted contact_vault (invariant #5). A
// contact is PII: keep it out of events, need rows, and logs.

export interface NormalizedContact {
  /** Canonical 10-digit Indian mobile (country code / trunk 0 stripped). */
  digits: string;
  /** Human display form, e.g. "+91 98400 05678". */
  display: string;
}

/**
 * Normalize a raw contact string. Accepts +91XXXXXXXXXX, 0XXXXXXXXXX, a bare 10-digit
 * mobile [6-9]\d{9}, and spaced/dashed/parenthesized variants. Returns null when the
 * input can't be a valid Indian mobile number (null in → null out).
 */
export function normalizeContact(raw: string | null): NormalizedContact | null {
  if (raw === null) return null;
  let digits = raw.replace(/\D+/g, '');
  if (digits === '') return null;
  // Strip an Indian country code (+91 / 0091) or a trunk 0 so only the subscriber
  // number remains.
  if (digits.length === 14 && digits.startsWith('0091')) digits = digits.slice(4);
  else if (digits.length === 13 && digits.startsWith('091')) digits = digits.slice(3);
  else if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  // A valid Indian mobile is exactly 10 digits starting 6-9.
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  const display = `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
  return { digits, display };
}

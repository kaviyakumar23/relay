import type { EvidenceKind, ProjectedNeed } from '../ledger/types';
import { context, escapeMrkdwn, type SlackBlock, section } from './primitives';
import { EVIDENCE_KIND_LABEL, type VerificationStatus, verificationStatus } from './verification';

// The evidence trail (BUILD-DOC §F5): a Block Kit rendering of a need's evidence packet as a
// CHECKLIST — 📷 photo / 📍 location / 🙋 recipient / ✅ sign-off, each ticked ✓ (with its time)
// or shown pending ○ when the policy still needs it — under a prominent verification-level badge.
// A proven 'Verified · Closed' trail should read as an accomplishment, not a log dump. Pure over
// the projection: it renders REFERENCES + kinds + times only, never beneficiary content
// (zero-copy + PII, CLAUDE.md invariant #5). Every close renders one of these as its proof.

const EVIDENCE_ICON: Record<EvidenceKind, string> = {
  photo: '📷',
  locality_confirm: '📍',
  recipient_confirm: '🙋',
  coordinator_signoff: '✅',
};

/** Short checklist labels (the packet's own vocabulary; EVIDENCE_KIND_LABEL is the prose form). */
const CHECK_LABEL: Record<EvidenceKind, string> = {
  photo: 'Photo',
  locality_confirm: 'Location',
  recipient_confirm: 'Recipient',
  coordinator_signoff: 'Sign-off',
};

/** Canonical L1→L3 order for the checklist (mirrors verification.ts KIND_ORDER, kept local). */
const CHECKLIST_ORDER: readonly EvidenceKind[] = [
  'photo',
  'locality_confirm',
  'recipient_confirm',
  'coordinator_signoff',
];

/** ISO → 'YYYY-MM-DD HH:MM:SS UTC' (second precision), matching the dispatch card style. */
function timeLabel(iso: string): string {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

/** The verification badge text, e.g. 'Verification: L2 ✓ — meets L2 policy' or, when short of
 *  policy, 'Verification: L2 / L3 required — missing: photo, location'. Rendered as a prominent
 *  (bold section) line so a met packet reads as a completed, verified accomplishment. */
function badgeText(v: VerificationStatus): string {
  const shortLevel = `L${v.level}`;
  const shortReq = v.requiredLabel.split(' ')[0]; // 'L3 (…)' → 'L3'
  if (v.meetsPolicy) return `Verification: ${shortLevel} ✓ — meets ${shortReq} policy`;
  const miss = v.missing.map((k) => EVIDENCE_KIND_LABEL[k]).join(', ');
  return `Verification: ${shortLevel} / ${shortReq} required — missing: ${miss}`;
}

/**
 * Build the evidence-packet blocks: a heading with the item count, a checklist of the evidence
 * kinds that are present (✓ + time) or still required (○ pending), then the prominent
 * verification badge. An empty packet renders a "cannot be verified" note in place of the
 * checklist. Pure over the projection.
 */
export function buildEvidencePacket(need: ProjectedNeed): SlackBlock[] {
  const v = verificationStatus(need);
  const count = need.evidence.length;
  const blocks: SlackBlock[] = [section(`*Evidence packet* · ${count} item${count === 1 ? '' : 's'}`)];

  if (count === 0) {
    blocks.push(context('_No evidence attached yet — delivery cannot be verified._'));
  } else {
    // First attached ref per kind (kind + time only — never content).
    const firstOf = new Map<EvidenceKind, (typeof need.evidence)[number]>();
    for (const ref of need.evidence) if (!firstOf.has(ref.kind)) firstOf.set(ref.kind, ref);
    const stillNeeded = new Set(v.missing);

    // Checklist: a line for every kind that is either attached (✓) or required-but-missing (○).
    for (const kind of CHECKLIST_ORDER) {
      const ref = firstOf.get(kind);
      if (ref !== undefined) {
        const idPart = ref.evidence_id ? `  ·  \`${escapeMrkdwn(ref.evidence_id)}\`` : '';
        blocks.push(context(`${EVIDENCE_ICON[kind]} *${CHECK_LABEL[kind]}* ✓  ·  ${timeLabel(ref.at)}${idPart}`));
      } else if (stillNeeded.has(kind)) {
        blocks.push(context(`${EVIDENCE_ICON[kind]} ${CHECK_LABEL[kind]} ○ _pending_`));
      }
    }
  }

  blocks.push(section(`${v.meetsPolicy ? '✅' : '⏳'} *${badgeText(v)}*`));
  return blocks;
}

import type { EvidenceKind, ProjectedNeed } from '../ledger/types';
import { context, escapeMrkdwn, type SlackBlock, section } from './primitives';
import { EVIDENCE_KIND_LABEL, type VerificationStatus, verificationStatus } from './verification';

// The evidence trail (BUILD-DOC §F5): a linkable Block Kit rendering of a need's evidence
// packet — one line per EvidenceRef (icon + kind + time + optional reference id) topped by
// a verification-level badge derived from verificationStatus. Pure over the projection:
// it renders REFERENCES + kinds + times only, never beneficiary content (zero-copy + PII,
// CLAUDE.md invariant #5). Every close renders one of these as its proof.

const EVIDENCE_ICON: Record<EvidenceKind, string> = {
  photo: '📷',
  locality_confirm: '📍',
  recipient_confirm: '🙋',
  coordinator_signoff: '✅',
};

/** ISO → 'YYYY-MM-DD HH:MM:SS UTC' (second precision), matching the dispatch card style. */
function timeLabel(iso: string): string {
  return `${iso.slice(0, 19).replace('T', ' ')} UTC`;
}

/** The one-line verification badge, e.g. 'Verification: L2 ✓ — meets L2 policy' or, when
 *  short of policy, 'Verification: L2 / L3 required — missing: photo, location'. */
function badgeText(v: VerificationStatus): string {
  const shortLevel = `L${v.level}`;
  const shortReq = v.requiredLabel.split(' ')[0]; // 'L3 (…)' → 'L3'
  if (v.meetsPolicy) return `Verification: ${shortLevel} ✓ — meets ${shortReq} policy`;
  const miss = v.missing.map((k) => EVIDENCE_KIND_LABEL[k]).join(', ');
  return `Verification: ${shortLevel} / ${shortReq} required — missing: ${miss}`;
}

/**
 * Build the evidence-packet blocks for a need: a heading with the item count, one context
 * line per attached EvidenceRef, and the verification badge. An empty packet renders a
 * "cannot be verified" note in place of the lines. Pure over the projection.
 */
export function buildEvidencePacket(need: ProjectedNeed): SlackBlock[] {
  const v = verificationStatus(need);
  const count = need.evidence.length;
  const blocks: SlackBlock[] = [section(`*Evidence packet* · ${count} item${count === 1 ? '' : 's'}`)];

  if (count === 0) {
    blocks.push(context('_No evidence attached yet — delivery cannot be verified._'));
  } else {
    for (const ref of need.evidence) {
      const idPart = ref.evidence_id ? `  ·  \`${escapeMrkdwn(ref.evidence_id)}\`` : '';
      blocks.push(
        context(`${EVIDENCE_ICON[ref.kind]} ${EVIDENCE_KIND_LABEL[ref.kind]}  ·  ${timeLabel(ref.at)}${idPart}`),
      );
    }
  }

  blocks.push(context(badgeText(v)));
  return blocks;
}

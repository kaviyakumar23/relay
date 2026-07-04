// Store-layer errors shared by the memory and Postgres substrates.

/**
 * Raised when an append's `expectedVersion` does not match the need's current event
 * count — i.e. another writer advanced the need between our read and our write.
 * NeedService.dispatch catches this and retries (re-read → re-decide → re-append),
 * so two different commands racing on one need serialize by causality instead of
 * silently both applying.
 */
export class ConcurrencyError extends Error {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
    readonly needId?: string,
  ) {
    super(
      `concurrency conflict: expected version ${expectedVersion}, found ${actualVersion}${needId ? ` for ${needId}` : ''}`,
    );
    this.name = 'ConcurrencyError';
  }
}

export type GuardViolationCode =
  | 'ILLEGAL_TRANSITION'
  | 'HUMAN_GATE'
  | 'EVIDENCE_REQUIRED'
  | 'INSUFFICIENT_EVIDENCE'
  | 'UNKNOWN_NEED'
  | 'RAW_CONTENT_PERSISTED';

/** Thrown by the zero-copy guard (invariant #5) before any raw content reaches the log. */
export class GuardViolation extends Error {
  constructor(
    message: string,
    readonly code: GuardViolationCode,
  ) {
    super(message);
    this.name = 'GuardViolation';
  }
}

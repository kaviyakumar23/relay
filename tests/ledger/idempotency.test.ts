import { describe, expect, it } from 'vitest';
import { needCreatedKey, needEventKey, timerEventKey } from '../../src/ledger/idempotency';

describe('idempotency keys', () => {
  it('is deterministic: same happening, same key', () => {
    const a = needCreatedKey('T123', 'C456', '1720100000.000100');
    const b = needCreatedKey('T123', 'C456', '1720100000.000100');
    expect(a).toBe(b);
  });

  it('distinguishes distinct happenings', () => {
    const base = needCreatedKey('T123', 'C456', '1720100000.000100');
    expect(needCreatedKey('T123', 'C456', '1720100000.000200')).not.toBe(base);
    expect(needCreatedKey('T123', 'C999', '1720100000.000100')).not.toBe(base);
    expect(needCreatedKey('T999', 'C456', '1720100000.000100')).not.toBe(base);
  });

  it('keys lifecycle events by need, type, and discriminator', () => {
    const claim1 = needEventKey('n-1', 'Claimed', 'ob-1');
    const claim2 = needEventKey('n-1', 'Claimed', 'ob-2');
    expect(claim1).not.toBe(claim2);
    expect(needEventKey('n-1', 'Claimed', 'ob-1')).toBe(claim1);
  });

  it('gives timer re-fires a fresh key only when state advanced', () => {
    const v1 = timerEventKey('ob-1', 'NUDGE', 1);
    expect(timerEventKey('ob-1', 'NUDGE', 1)).toBe(v1);
    expect(timerEventKey('ob-1', 'NUDGE', 2)).not.toBe(v1);
  });
});

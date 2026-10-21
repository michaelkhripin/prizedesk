import { describe, expect, it } from 'vitest';
import { PolicyError, parsePrizePolicyText, parseRevenuePolicyText, validateRevenuePolicy } from './policy.js';

describe('parseRevenuePolicyText', () => {
  it('reads the demo policy', () => {
    const { policy, defaulted } = parseRevenuePolicyText(
      '70% by engaged playtime, 30% by unique players, cap each creator at 25%, minimum payout $10, hold anyone flagged for review',
    );
    expect(policy).toEqual({
      weights: { engagedMinutes: 0.7, uniquePlayers: 0.3 },
      capBps: 2500,
      minPayoutCents: 1000,
      holdFlagged: true,
    });
    expect(defaulted).toEqual([]);
  });

  it('infers the missing weight and reports defaults', () => {
    const { policy, defaulted } = parseRevenuePolicyText('Split 60% on playtime, no cap');
    expect(policy.weights.uniquePlayers).toBeCloseTo(0.4);
    expect(policy.capBps).toBe(10000);
    expect(defaulted).toEqual(['minimum', 'hold']);
  });

  it('understands "do not hold"', () => {
    expect(parseRevenuePolicyText('pay out, do not hold flagged creators').policy.holdFlagged).toBe(false);
  });

  it('rejects weights that do not add up', () => {
    expect(() => parseRevenuePolicyText('80% by playtime and 40% by unique players')).toThrow(PolicyError);
  });
});

describe('validateRevenuePolicy', () => {
  it('rejects a zero cap and fractional cents', () => {
    const base = { weights: { engagedMinutes: 1, uniquePlayers: 0 }, capBps: 2500, minPayoutCents: 0, holdFlagged: true };
    expect(() => validateRevenuePolicy({ ...base, capBps: 0 })).toThrow(PolicyError);
    expect(() => validateRevenuePolicy({ ...base, minPayoutCents: 9.5 })).toThrow(PolicyError);
  });
});

describe('parsePrizePolicyText', () => {
  it('reads slash and ordinal forms', () => {
    expect(parsePrizePolicyText('50/30/20, hold flagged teams').policy.placementBps).toEqual([5000, 3000, 2000]);
    expect(parsePrizePolicyText('1st gets 60%, 2nd 25%, 3rd 15%').policy.placementBps).toEqual([6000, 2500, 1500]);
  });

  it('rejects placements that do not add up to 100%', () => {
    expect(() => parsePrizePolicyText('50/30/10')).toThrow(PolicyError);
  });
});

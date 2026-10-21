import { describe, expect, it } from 'vitest';
import { apportion, capShares, splitPrizePool, splitRevenueShare } from './split.js';
import { generateSeason, generateTournament, BENEFITING_TEAM, PLANTED } from './generate.js';
import { detectSeasonAnomalies, detectTournamentAnomalies } from './anomalies.js';
import { DEFAULT_PRIZE_POLICY, DEFAULT_REVENUE_POLICY } from './policy.js';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('apportion', () => {
  it('always adds up to the total, in whole cents', () => {
    const parts = apportion(100_00, [1, 1, 1]);
    expect(sum(parts)).toBe(100_00);
    expect(parts.every(Number.isInteger)).toBe(true);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });

  it('gives nothing when there is nothing to split', () => {
    expect(apportion(0, [1, 2])).toEqual([0, 0]);
    expect(apportion(500, [0, 0])).toEqual([0, 0]);
  });
});

describe('capShares', () => {
  it('caps and redistributes the excess proportionally', () => {
    const out = capShares([0.5, 0.3, 0.2], 0.4);
    expect(out[0]).toBeCloseTo(0.4);
    expect(out[1]).toBeCloseTo(0.36);
    expect(out[2]).toBeCloseTo(0.24);
  });

  it('re-caps a recipient pushed over the cap by redistribution', () => {
    const out = capShares([0.5, 0.35, 0.1, 0.05], 0.3);
    expect(Math.max(...out)).toBeLessThanOrEqual(0.3 + 1e-9);
    expect(sum(out)).toBeCloseTo(1);
  });

  it('leaves money unassigned when everyone is capped', () => {
    expect(sum(capShares([0.5, 0.5], 0.25))).toBeCloseTo(0.5);
  });
});

describe('splitRevenueShare', () => {
  const season = generateSeason();
  const flags = detectSeasonAnomalies(season);

  it('pays out exactly the pool', () => {
    const { allocations, unassignedCents } = splitRevenueShare(season, DEFAULT_REVENUE_POLICY, flags);
    expect(sum(allocations.map((a) => a.amountCents)) + unassignedCents).toBe(season.poolCents);
    expect(unassignedCents).toBe(0);
  });

  it('respects the cap', () => {
    const { allocations } = splitRevenueShare(season, { ...DEFAULT_REVENUE_POLICY, capBps: 1000 }, flags);
    expect(Math.max(...allocations.map((a) => a.amountCents))).toBeLessThanOrEqual(season.poolCents * 0.1 + 1);
  });

  it('holds high-severity creators and rolls over tiny amounts', () => {
    const { allocations } = splitRevenueShare(season, { ...DEFAULT_REVENUE_POLICY, minPayoutCents: 50_00 }, flags);
    const byId = new Map(allocations.map((a) => [a.recipientId, a]));
    expect(byId.get(season.creators[PLANTED.botCreator]!.id)!.status).toBe('held');
    for (const i of PLANTED.sharedEmailPair) expect(byId.get(season.creators[i]!.id)!.status).toBe('held');
    for (const a of allocations.filter((x) => x.status === 'below_minimum')) {
      expect(a.amountCents).toBeLessThan(50_00);
    }
  });

  it('pays flagged creators when the policy says not to hold', () => {
    const { allocations } = splitRevenueShare(season, { ...DEFAULT_REVENUE_POLICY, holdFlagged: false }, flags);
    expect(allocations.some((a) => a.status === 'held')).toBe(false);
  });
});

describe('splitPrizePool', () => {
  const cup = generateTournament();
  const flags = detectTournamentAnomalies(cup);

  it('splits the pool by placement and evenly inside a team', () => {
    const { allocations, unassignedCents } = splitPrizePool(cup, DEFAULT_PRIZE_POLICY, flags);
    expect(allocations).toHaveLength(9);
    expect(sum(allocations.map((a) => a.amountCents)) + unassignedCents).toBe(cup.poolCents);
    const first = allocations.filter((a) => a.reasons.includes('place_1')).map((a) => a.amountCents);
    expect(sum(first)).toBe(cup.poolCents * 0.5);
  });

  it('holds the team that was handed a thrown match', () => {
    expect(cup.placements[0]).toBe(cup.teams[BENEFITING_TEAM]!.id);
    const { allocations } = splitPrizePool(cup, DEFAULT_PRIZE_POLICY, flags);
    const champions = allocations.filter((a) => a.reasons.includes('place_1'));
    expect(champions.every((a) => a.status === 'held')).toBe(true);
  });
});

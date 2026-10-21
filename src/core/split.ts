import type {
  Allocation,
  Flag,
  PrizePolicy,
  RevenueSharePolicy,
  Season,
  Tournament,
} from './types.js';

/**
 * Splits `totalCents` proportionally to `weights` so the parts are whole cents
 * and add up to exactly `totalCents` (largest remainder method).
 */
export function apportion(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0 || totalCents <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const parts = exact.map(Math.floor);
  let left = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left === 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

/**
 * Caps every share at `cap` and hands the excess to the uncapped recipients in
 * proportion to their original shares. Returns shares summing to <= 1; the
 * remainder is only non-zero when everyone is capped.
 */
export function capShares(shares: number[], cap: number): number[] {
  const out = [...shares];
  const capped = new Set<number>();
  for (;;) {
    const over = out.flatMap((s, i) => (!capped.has(i) && s > cap + 1e-12 ? [i] : []));
    if (over.length === 0) return out;
    let excess = 0;
    for (const i of over) {
      excess += out[i]! - cap;
      out[i] = cap;
      capped.add(i);
    }
    const free = out.flatMap((_, i) => (capped.has(i) ? [] : [i]));
    const freeBase = free.reduce((a, i) => a + shares[i]!, 0);
    if (free.length === 0 || freeBase <= 0) return out;
    for (const i of free) out[i]! += (excess * shares[i]!) / freeBase;
  }
}

function heldIds(flags: Flag[]): Set<string> {
  return new Set(flags.filter((f) => f.severity === 'high').map((f) => f.subjectId));
}

export interface SplitResult {
  allocations: Allocation[];
  /** Cents not assigned to anyone (only when the cap leaves money over). */
  unassignedCents: number;
}

export function splitRevenueShare(
  season: Season,
  policy: RevenueSharePolicy,
  flags: Flag[],
): SplitResult {
  const stats = season.stats;
  const totalMinutes = stats.reduce((a, s) => a + s.engagedMinutes, 0);
  const totalPlayers = stats.reduce((a, s) => a + s.uniquePlayers, 0);
  const raw = stats.map(
    (s) =>
      policy.weights.engagedMinutes * (totalMinutes ? s.engagedMinutes / totalMinutes : 0) +
      policy.weights.uniquePlayers * (totalPlayers ? s.uniquePlayers / totalPlayers : 0),
  );
  const rawSum = raw.reduce((a, b) => a + b, 0);
  const normalized = raw.map((r) => (rawSum ? r / rawSum : 0));
  const shares = capShares(normalized, policy.capBps / 10000);

  const assigned = Math.round(season.poolCents * shares.reduce((a, b) => a + b, 0));
  const amounts = apportion(assigned, shares);
  const held = policy.holdFlagged ? heldIds(flags) : new Set<string>();
  const byId = new Map(season.creators.map((c) => [c.id, c]));

  const allocations = stats.map((s, i): Allocation => {
    const reasons: string[] = [];
    if (normalized[i]! > shares[i]! + 1e-12) reasons.push('capped');
    let status: Allocation['status'] = 'payable';
    if (held.has(s.creatorId)) {
      status = 'held';
      reasons.push('high_severity_flag');
    } else if (amounts[i]! < policy.minPayoutCents) {
      status = 'below_minimum';
      reasons.push('rolled_over_to_next_season');
    }
    return {
      recipientId: s.creatorId,
      payoutEmail: byId.get(s.creatorId)?.payoutEmail ?? '',
      shareBps: Math.round(shares[i]! * 10000),
      amountCents: amounts[i]!,
      status,
      reasons,
    };
  });
  return { allocations, unassignedCents: season.poolCents - assigned };
}

export function splitPrizePool(
  tournament: Tournament,
  policy: PrizePolicy,
  flags: Flag[],
): SplitResult {
  const places = tournament.placements.slice(0, policy.placementBps.length);
  const usedBps = policy.placementBps.slice(0, places.length);
  const teamAmounts = apportion(
    Math.round((tournament.poolCents * usedBps.reduce((a, b) => a + b, 0)) / 10000),
    usedBps,
  );
  const held = policy.holdFlagged ? heldIds(flags) : new Set<string>();

  const allocations: Allocation[] = [];
  places.forEach((teamId, place) => {
    const members = tournament.players.filter((p) => p.teamId === teamId);
    const memberAmounts = apportion(teamAmounts[place]!, members.map(() => 1));
    members.forEach((p, k) => {
      const reasons = [`place_${place + 1}`];
      let status: Allocation['status'] = 'payable';
      if (held.has(teamId) || held.has(p.id)) {
        status = 'held';
        reasons.push('high_severity_flag');
      } else if (memberAmounts[k]! < policy.minPayoutCents) {
        status = 'below_minimum';
        reasons.push('below_minimum_payout');
      }
      allocations.push({
        recipientId: p.id,
        payoutEmail: p.payoutEmail,
        shareBps: Math.round((usedBps[place]! / members.length) || 0),
        amountCents: memberAmounts[k]!,
        status,
        reasons,
      });
    });
  });
  const assigned = allocations.reduce((a, x) => a + x.amountCents, 0);
  return { allocations, unassignedCents: tournament.poolCents - assigned };
}

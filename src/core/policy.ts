import type { PrizePolicy, RevenueSharePolicy } from './types.js';

export const DEFAULT_REVENUE_POLICY: RevenueSharePolicy = {
  weights: { engagedMinutes: 0.7, uniquePlayers: 0.3 },
  capBps: 2500,
  minPayoutCents: 10_00,
  holdFlagged: true,
};

export const DEFAULT_PRIZE_POLICY: PrizePolicy = {
  placementBps: [5000, 3000, 2000],
  minPayoutCents: 1_00,
  holdFlagged: true,
};

export class PolicyError extends Error {}

/** Rejects anything an LLM (or a person) could get wrong before money moves. */
export function validateRevenuePolicy(p: RevenueSharePolicy): RevenueSharePolicy {
  const { engagedMinutes: a, uniquePlayers: b } = p.weights;
  if (![a, b].every((w) => Number.isFinite(w) && w >= 0 && w <= 1)) {
    throw new PolicyError('weights must be between 0 and 1');
  }
  if (Math.abs(a + b - 1) > 1e-6) throw new PolicyError('weights must add up to 100%');
  if (!Number.isInteger(p.capBps) || p.capBps < 1 || p.capBps > 10000) {
    throw new PolicyError('cap must be between 0.01% and 100%');
  }
  if (!Number.isInteger(p.minPayoutCents) || p.minPayoutCents < 0) {
    throw new PolicyError('minimum payout must be a non-negative amount in cents');
  }
  if (typeof p.holdFlagged !== 'boolean') throw new PolicyError('holdFlagged must be true or false');
  return p;
}

export function validatePrizePolicy(p: PrizePolicy): PrizePolicy {
  if (p.placementBps.length === 0) throw new PolicyError('at least one paid place is required');
  if (!p.placementBps.every((x) => Number.isInteger(x) && x > 0)) {
    throw new PolicyError('every paid place needs a positive share');
  }
  if (p.placementBps.reduce((a, b) => a + b, 0) !== 10000) {
    throw new PolicyError('placement shares must add up to 100%');
  }
  if (!Number.isInteger(p.minPayoutCents) || p.minPayoutCents < 0) {
    throw new PolicyError('minimum payout must be a non-negative amount in cents');
  }
  return p;
}

export interface Parsed<T> {
  policy: T;
  /** Which fields fell back to defaults, so the UI can say so. */
  defaulted: string[];
}

const pct = (s: string) => Math.round(Number(s) * 100);

function holdFrom(text: string): boolean | undefined {
  if (/\b(don'?t|do not|never)\s+hold\b|\bpay (?:everyone|all) (?:including|even) flagged\b/.test(text)) return false;
  if (/\bhold\b|\bfreeze\b|\b(don'?t|do not) pay flagged\b/.test(text)) return true;
  return undefined;
}

function minFrom(text: string): number | undefined {
  const m =
    text.match(/min(?:imum)?(?:\s+payout)?\s*(?:of|is|=|:)?\s*\$\s*(\d+(?:\.\d{1,2})?)/) ??
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*min(?:imum)?/);
  return m ? Math.round(Number(m[1]) * 100) : undefined;
}

/**
 * Deterministic reader for revenue-share rules written in plain English. The
 * LLM path produces the same structure; this one runs without any API key and
 * is what the tests and the offline demo use.
 */
export function parseRevenuePolicyText(input: string): Parsed<RevenueSharePolicy> {
  const text = input.toLowerCase();
  const defaulted: string[] = [];
  const d = DEFAULT_REVENUE_POLICY;

  const minutes = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:by|on|from|for)?\s*(?:engaged\s+)?(?:play\s*time|playtime|time|minutes)/);
  const players = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:by|on|from|for)?\s*(?:unique\s+)?(?:players|reach|audience)/);
  let weights = d.weights;
  if (minutes || players) {
    const a = minutes ? Number(minutes[1]) / 100 : 1 - Number(players![1]) / 100;
    const b = players ? Number(players[1]) / 100 : 1 - a;
    weights = { engagedMinutes: a, uniquePlayers: b };
  } else {
    defaulted.push('weights');
  }

  const cap =
    text.match(/cap(?:ped)?\s*(?:each creator\s*)?(?:at|of|to)?\s*(\d+(?:\.\d+)?)\s*%/) ??
    text.match(/(?:no more than|at most|max(?:imum)?)\s*(\d+(?:\.\d+)?)\s*%/) ??
    text.match(/(\d+(?:\.\d+)?)\s*%\s*cap/);
  const noCap = /\bno cap\b/.test(text);
  const capBps = noCap ? 10000 : cap ? pct(cap[1]!) : (defaulted.push('cap'), d.capBps);

  const min = minFrom(text);
  if (min === undefined) defaulted.push('minimum');
  const hold = holdFrom(text);
  if (hold === undefined) defaulted.push('hold');

  const policy = validateRevenuePolicy({
    weights,
    capBps,
    minPayoutCents: min ?? d.minPayoutCents,
    holdFlagged: hold ?? d.holdFlagged,
  });
  return { policy, defaulted };
}

export function parsePrizePolicyText(input: string): Parsed<PrizePolicy> {
  const text = input.toLowerCase();
  const defaulted: string[] = [];
  const d = DEFAULT_PRIZE_POLICY;

  let placementBps: number[] | undefined;
  const slashed = text.match(/(\d+(?:\.\d+)?)(?:\s*%)?(?:\s*\/\s*(\d+(?:\.\d+)?)(?:\s*%)?)+/);
  if (slashed) {
    placementBps = slashed[0].split('/').map((x) => pct(x.replace('%', '').trim()));
  } else {
    const places = [...text.matchAll(/(\d+)(?:st|nd|rd|th)(?:\s+place)?\s*(?:gets|:|-|=)?\s*(\d+(?:\.\d+)?)\s*%/g)];
    if (places.length) {
      placementBps = places
        .sort((a, b) => Number(a[1]) - Number(b[1]))
        .map((m) => pct(m[2]!));
    }
  }
  if (!placementBps) defaulted.push('placements');

  const min = minFrom(text);
  if (min === undefined) defaulted.push('minimum');
  const hold = holdFrom(text);
  if (hold === undefined) defaulted.push('hold');

  const policy = validatePrizePolicy({
    placementBps: placementBps ?? d.placementBps,
    minPayoutCents: min ?? d.minPayoutCents,
    holdFlagged: hold ?? d.holdFlagged,
  });
  return { policy, defaulted };
}

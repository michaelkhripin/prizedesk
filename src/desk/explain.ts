import type { Allocation, Flag } from '../core/index.js';

export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Plain-English reading of a flag. The LLM may rephrase it; the facts come from here. */
export function describeFlag(f: Flag): string {
  const e = f.evidence;
  switch (f.kind) {
    case 'bot_sessions':
      return `median session of ${e.medianSessionSec}s across ${Number(e.plays).toLocaleString('en-US')} plays (season top quarter starts at ${Number(e.seasonP75Plays).toLocaleString('en-US')}), which looks scripted`;
    case 'repeat_play_farming':
      return `${e.playsPerUniquePlayer} plays per unique player from only ${e.uniquePlayers} players, which looks like a few accounts replaying for payout`;
    case 'report_spike':
      return `${e.reportsPer1kPlays} player reports per 1,000 plays against a season median of ${e.seasonMedian}`;
    case 'shared_payout_account':
      return `pays out to the same inbox (${e.normalizedEmail}) as ${e.sharedWith}`;
    case 'suspicious_match':
      return `match ${e.matchId} ended in ${e.durationSec}s against a median of ${e.medianDurationSec}s with the losing side scoring ${e.loserScore}`;
  }
}

export function describeAllocation(a: Allocation): string {
  const share = `${(a.shareBps / 100).toFixed(2)}% of the pool`;
  if (a.status === 'held') return `${usd(a.amountCents)} (${share}) reserved but held for review`;
  if (a.status === 'below_minimum') return `${usd(a.amountCents)} is under the minimum payout and rolls over to next season`;
  return `${usd(a.amountCents)} (${share})${a.reasons.includes('capped') ? ', reduced to the per-creator cap' : ''}`;
}

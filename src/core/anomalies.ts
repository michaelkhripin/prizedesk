import type { Flag, Season, Tournament } from './types.js';

export const THRESHOLDS = {
  /** Sessions this short at high volume look scripted. */
  botMedianSessionSec: 20,
  /** Plays-per-unique-player above this means a few accounts replaying for payout. */
  repeatPlaysPerPlayer: 40,
  /** Reports per 1k plays above this multiple of the season median. */
  reportSpikeMultiple: 4,
  /** Ignore report rates built on fewer reports than this; small maps are noisy. */
  minReports: 10,
  /** Matches shorter than this fraction of the median match length. */
  shortMatchFraction: 0.25,
} as const;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

/** Lower-cases and strips Gmail-style dots and +tags so aliases of one inbox collide. */
export function normalizeEmail(email: string): string {
  const [local = '', domain = ''] = email.trim().toLowerCase().split('@');
  const base = local.split('+')[0]!;
  const gmail = domain === 'gmail.com' || domain === 'googlemail.com';
  return `${gmail ? base.replaceAll('.', '') : base}@${gmail ? 'gmail.com' : domain}`;
}

export function sharedPayoutAccounts(
  recipients: { id: string; payoutEmail: string }[],
): Flag[] {
  const groups = new Map<string, string[]>();
  for (const r of recipients) {
    const key = normalizeEmail(r.payoutEmail);
    groups.set(key, [...(groups.get(key) ?? []), r.id]);
  }
  return [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .flatMap(([email, ids]) =>
      ids.map((id): Flag => ({
        subjectId: id,
        kind: 'shared_payout_account',
        severity: 'high',
        evidence: { normalizedEmail: email, sharedWith: ids.filter((x) => x !== id).join(', ') },
      })),
    );
}

export function detectSeasonAnomalies(season: Season): Flag[] {
  const flags: Flag[] = [];
  const stats = season.stats;
  const playsP75 = quantile(stats.map((s) => s.plays), 0.75);
  const reportRates = stats.map((s) => (s.plays ? (s.reports * 1000) / s.plays : 0));
  const medianReportRate = median(reportRates);

  stats.forEach((s, i) => {
    if (s.medianSessionSec < THRESHOLDS.botMedianSessionSec && s.plays >= playsP75) {
      flags.push({
        subjectId: s.creatorId,
        kind: 'bot_sessions',
        severity: 'high',
        evidence: { medianSessionSec: s.medianSessionSec, plays: s.plays, seasonP75Plays: playsP75 },
      });
    }
    const perPlayer = s.uniquePlayers ? s.plays / s.uniquePlayers : s.plays;
    if (perPlayer > THRESHOLDS.repeatPlaysPerPlayer) {
      flags.push({
        subjectId: s.creatorId,
        kind: 'repeat_play_farming',
        severity: 'medium',
        evidence: { playsPerUniquePlayer: Math.round(perPlayer), uniquePlayers: s.uniquePlayers },
      });
    }
    const rate = reportRates[i]!;
    if (
      s.reports >= THRESHOLDS.minReports &&
      medianReportRate > 0 &&
      rate > medianReportRate * THRESHOLDS.reportSpikeMultiple
    ) {
      flags.push({
        subjectId: s.creatorId,
        kind: 'report_spike',
        severity: 'medium',
        evidence: {
          reportsPer1kPlays: Number(rate.toFixed(2)),
          seasonMedian: Number(medianReportRate.toFixed(2)),
        },
      });
    }
  });

  return [...flags, ...sharedPayoutAccounts(season.creators)];
}

export function detectTournamentAnomalies(t: Tournament): Flag[] {
  const flags: Flag[] = [];
  const medianDuration = median(t.matches.map((m) => m.durationSec));
  for (const m of t.matches) {
    const loser = m.winner === m.teamA ? m.teamB : m.teamA;
    const loserScore = m.winner === m.teamA ? m.scoreB : m.scoreA;
    if (m.durationSec < medianDuration * THRESHOLDS.shortMatchFraction && loserScore === 0) {
      const evidence = {
        matchId: m.matchId,
        round: m.round,
        durationSec: m.durationSec,
        medianDurationSec: medianDuration,
        loserScore,
      };
      // The team that advanced is the one a payout would reward, so it is held;
      // the side that may have thrown the match gets a softer flag.
      flags.push({ subjectId: m.winner, kind: 'suspicious_match', severity: 'high', evidence });
      flags.push({ subjectId: loser, kind: 'suspicious_match', severity: 'medium', evidence });
    }
  }
  return [...flags, ...sharedPayoutAccounts(t.players)];
}

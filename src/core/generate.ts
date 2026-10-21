import type { Creator, CreatorSeasonStats, MatchResult, Player, Season, Team, Tournament } from './types.js';

/** Small deterministic PRNG so demo data is identical on every machine. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ADJ = ['Neon', 'Rusty', 'Quiet', 'Lucky', 'Frost', 'Hollow', 'Brave', 'Pixel', 'Ember', 'Velvet', 'Atomic', 'Mossy'];
const NOUN = ['Fox', 'Forge', 'Atlas', 'Golem', 'Comet', 'Lantern', 'Badger', 'Harbor', 'Raven', 'Maple', 'Circuit', 'Otter'];
const COUNTRIES = ['US', 'DE', 'BR', 'PL', 'GB', 'FR', 'CA', 'ES', 'SE', 'MX', 'AU', 'CY'];

function pick<T>(rnd: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rnd() * xs.length)]!;
}

/** Heavy-tailed popularity, like real UGC: a few hits, a long tail. */
function popularity(rnd: () => number): number {
  return Math.exp(rnd() * 4.2);
}

export interface SeasonOptions {
  seed?: number;
  creators?: number;
  poolCents?: number;
}

/**
 * Indices of the planted cases in a generated season, so tests and the demo
 * script can point at them.
 */
export const PLANTED = {
  botCreator: 3,
  farmingCreator: 7,
  sharedEmailPair: [11, 12] as const,
  reportSpikeCreator: 15,
};

export function generateSeason(opts: SeasonOptions = {}): Season {
  const { seed = 2026, creators: n = 40, poolCents = 25_000_00 } = opts;
  const rnd = mulberry32(seed);
  const creators: Creator[] = [];
  const stats: CreatorSeasonStats[] = [];

  for (let i = 0; i < n; i++) {
    const handle = `${pick(rnd, ADJ)}${pick(rnd, NOUN)}${10 + i}`;
    const id = `cr_${String(i + 1).padStart(3, '0')}`;
    creators.push({
      id,
      handle,
      payoutEmail: `${handle.toLowerCase()}@example.com`,
      country: pick(rnd, COUNTRIES),
    });
    const pop = popularity(rnd);
    const uniquePlayers = Math.round(120 * pop + rnd() * 80);
    const plays = Math.round(uniquePlayers * (2 + rnd() * 4));
    const medianSessionSec = Math.round(240 + rnd() * 900);
    stats.push({
      creatorId: id,
      plays,
      uniquePlayers,
      medianSessionSec,
      engagedMinutes: Math.round((plays * medianSessionSec) / 60),
      reports: Math.round((plays / 1000) * (0.5 + rnd() * 1.5)),
    });
  }

  // Bot farm: huge play counts, sessions of a few seconds.
  const bot = stats[PLANTED.botCreator]!;
  bot.plays = 180_000;
  bot.uniquePlayers = 9_000;
  bot.medianSessionSec = 9;
  bot.engagedMinutes = Math.round((bot.plays * bot.medianSessionSec) / 60);

  // A handful of accounts replaying one map over and over.
  const farm = stats[PLANTED.farmingCreator]!;
  farm.uniquePlayers = 60;
  farm.plays = 4_200;
  farm.engagedMinutes = Math.round((farm.plays * farm.medianSessionSec) / 60);

  // Two creator accounts paying out to the same inbox (Gmail alias trick).
  const [a, b] = PLANTED.sharedEmailPair;
  creators[a]!.payoutEmail = 'jordan.miller.maps@gmail.com';
  creators[b]!.payoutEmail = 'jordanmillermaps+alt@gmail.com';

  // Players reporting a map far more than any other.
  const spiky = stats[PLANTED.reportSpikeCreator]!;
  spiky.reports = Math.max(30, Math.round((spiky.plays / 1000) * 25));

  return { id: 'season_7', name: 'Season 7 Creator Fund', poolCents, creators, stats };
}

export interface TournamentOptions {
  seed?: number;
  poolCents?: number;
}

/** Team index that throws its quarter-final in the generated bracket. */
export const THROWING_TEAM = 5;
/** Team that is handed that win and goes on to take the cup. */
export const BENEFITING_TEAM = 4;

export function generateTournament(opts: TournamentOptions = {}): Tournament {
  const { seed = 7, poolCents = 10_000_00 } = opts;
  const rnd = mulberry32(seed);
  const teams: Team[] = Array.from({ length: 8 }, (_, i) => ({
    id: `tm_${i + 1}`,
    name: `${pick(rnd, ADJ)} ${pick(rnd, NOUN)}s`,
  }));
  const players: Player[] = teams.flatMap((t, ti) =>
    Array.from({ length: 3 }, (_, k) => {
      const handle = `${pick(rnd, NOUN).toLowerCase()}_${ti}${k}`;
      return { id: `pl_${ti + 1}${k + 1}`, handle, payoutEmail: `${handle}@example.com`, teamId: t.id };
    }),
  );

  const strength = new Map(teams.map((t) => [t.id, rnd()]));
  strength.set(teams[BENEFITING_TEAM]!.id, 1.5);
  const matches: MatchResult[] = [];
  let alive = teams.map((t) => t.id);
  let round = 1;
  const eliminated: string[][] = [];
  while (alive.length > 1) {
    const next: string[] = [];
    const out: string[] = [];
    for (let i = 0; i < alive.length; i += 2) {
      const [teamA, teamB] = [alive[i]!, alive[i + 1]!];
      const thrown = round === 1 && (teamA === teams[THROWING_TEAM]!.id || teamB === teams[THROWING_TEAM]!.id);
      let winner: string;
      if (thrown) {
        winner = teamA === teams[THROWING_TEAM]!.id ? teamB : teamA;
      } else {
        winner = strength.get(teamA)! + rnd() * 0.4 > strength.get(teamB)! + rnd() * 0.4 ? teamA : teamB;
      }
      const loserScore = thrown ? 0 : Math.floor(rnd() * 3);
      matches.push({
        matchId: `m_${round}_${i / 2 + 1}`,
        round,
        teamA,
        teamB,
        winner,
        scoreA: winner === teamA ? 3 : loserScore,
        scoreB: winner === teamB ? 3 : loserScore,
        durationSec: thrown ? 140 : Math.round(1500 + rnd() * 900),
      });
      next.push(winner);
      out.push(winner === teamA ? teamB : teamA);
    }
    eliminated.push(out);
    alive = next;
    round++;
  }
  // 1st = champion, 2nd = final loser, 3rd = earlier of the semi-final losers.
  const placements = [alive[0]!, ...eliminated.reverse().flat()];
  return { id: 'cup_autumn', name: 'Autumn Community Cup', poolCents, teams, players, matches, placements };
}

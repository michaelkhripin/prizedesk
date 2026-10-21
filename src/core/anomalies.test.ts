import { describe, expect, it } from 'vitest';
import { detectSeasonAnomalies, detectTournamentAnomalies, normalizeEmail } from './anomalies.js';
import { BENEFITING_TEAM, PLANTED, THROWING_TEAM, generateSeason, generateTournament } from './generate.js';

describe('normalizeEmail', () => {
  it('collapses Gmail dots and +tags but leaves other domains alone', () => {
    expect(normalizeEmail('Jordan.Miller+alt@GMail.com')).toBe('jordanmiller@gmail.com');
    expect(normalizeEmail('jordan.miller@example.com')).toBe('jordan.miller@example.com');
  });
});

describe('detectSeasonAnomalies', () => {
  const season = generateSeason();
  const flags = detectSeasonAnomalies(season);
  const idOf = (i: number) => season.creators[i]!.id;
  const kindsFor = (i: number) => flags.filter((f) => f.subjectId === idOf(i)).map((f) => f.kind);

  it('finds every planted case', () => {
    expect(kindsFor(PLANTED.botCreator)).toContain('bot_sessions');
    expect(kindsFor(PLANTED.farmingCreator)).toContain('repeat_play_farming');
    expect(kindsFor(PLANTED.reportSpikeCreator)).toContain('report_spike');
    for (const i of PLANTED.sharedEmailPair) expect(kindsFor(i)).toContain('shared_payout_account');
  });

  it('does not flag ordinary creators', () => {
    const planted = new Set([
      PLANTED.botCreator,
      PLANTED.farmingCreator,
      PLANTED.reportSpikeCreator,
      ...PLANTED.sharedEmailPair,
    ].map(idOf));
    expect(flags.filter((f) => !planted.has(f.subjectId))).toEqual([]);
  });

  it('stays quiet on other seeds apart from planted cases', () => {
    for (const seed of [1, 2, 3, 42, 99]) {
      const s = generateSeason({ seed });
      const planted = new Set([3, 7, 11, 12, 15].map((i) => s.creators[i]!.id));
      expect(detectSeasonAnomalies(s).filter((f) => !planted.has(f.subjectId))).toEqual([]);
    }
  });
});

describe('detectTournamentAnomalies', () => {
  it('holds the beneficiary of a thrown match and soft-flags the thrower', () => {
    const cup = generateTournament();
    const flags = detectTournamentAnomalies(cup);
    expect(flags).toContainEqual(
      expect.objectContaining({ subjectId: cup.teams[BENEFITING_TEAM]!.id, severity: 'high' }),
    );
    expect(flags).toContainEqual(
      expect.objectContaining({ subjectId: cup.teams[THROWING_TEAM]!.id, severity: 'medium' }),
    );
    expect(flags).toHaveLength(2);
  });
});

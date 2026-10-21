// Writes the demo season and tournament to data/ and prints what the desk would do.
import { writeFileSync } from 'node:fs';
import {
  DEFAULT_PRIZE_POLICY,
  DEFAULT_REVENUE_POLICY,
  detectSeasonAnomalies,
  detectTournamentAnomalies,
  generateSeason,
  generateTournament,
  splitPrizePool,
  splitRevenueShare,
} from '../src/core/index.js';

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
const season = generateSeason();
const cup = generateTournament();
writeFileSync('data/season.json', JSON.stringify(season, null, 2));
writeFileSync('data/tournament.json', JSON.stringify(cup, null, 2));

for (const [name, flags, split] of [
  ['Season', detectSeasonAnomalies(season), splitRevenueShare(season, DEFAULT_REVENUE_POLICY, detectSeasonAnomalies(season))],
  ['Cup', detectTournamentAnomalies(cup), splitPrizePool(cup, DEFAULT_PRIZE_POLICY, detectTournamentAnomalies(cup))],
] as const) {
  const total = (s: string) => split.allocations.filter((a) => a.status === s).reduce((x, a) => x + a.amountCents, 0);
  console.log(`\n== ${name}: ${flags.length} flags, ${split.allocations.length} recipients`);
  for (const f of flags) console.log(`  ${f.severity.padEnd(6)} ${f.kind.padEnd(22)} ${f.subjectId} ${JSON.stringify(f.evidence)}`);
  console.log(`  payable ${usd(total('payable'))} · held ${usd(total('held'))} · rolled over ${usd(total('below_minimum'))} · unassigned ${usd(split.unassignedCents)}`);
  const top = [...split.allocations].sort((a, b) => b.amountCents - a.amountCents).slice(0, 5);
  for (const a of top) console.log(`  ${a.recipientId} ${usd(a.amountCents).padStart(10)} ${a.status} ${a.reasons.join(',')}`);
}

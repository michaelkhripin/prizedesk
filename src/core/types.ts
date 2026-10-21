// Money is always integer cents. Shares are basis points (1 bp = 0.01%).

export interface Creator {
  id: string;
  handle: string;
  payoutEmail: string;
  country: string;
}

/** One creator's numbers for a season, as exported from the game's analytics. */
export interface CreatorSeasonStats {
  creatorId: string;
  plays: number;
  engagedMinutes: number;
  uniquePlayers: number;
  medianSessionSec: number;
  reports: number;
}

export interface Player {
  id: string;
  handle: string;
  payoutEmail: string;
  teamId: string;
}

export interface Team {
  id: string;
  name: string;
}

export interface MatchResult {
  matchId: string;
  round: number;
  teamA: string;
  teamB: string;
  winner: string;
  scoreA: number;
  scoreB: number;
  durationSec: number;
}

export interface Season {
  id: string;
  name: string;
  poolCents: number;
  creators: Creator[];
  stats: CreatorSeasonStats[];
}

export interface Tournament {
  id: string;
  name: string;
  poolCents: number;
  teams: Team[];
  players: Player[];
  matches: MatchResult[];
  /** Team ids in final placement order, 1st place first. */
  placements: string[];
}

export interface RevenueSharePolicy {
  /** Weights of each metric in the score. Must sum to 1. */
  weights: { engagedMinutes: number; uniquePlayers: number };
  /** Max share of the pool one creator can get, in basis points (10000 = no cap). */
  capBps: number;
  /** Amounts below this are rolled over to next season instead of paid. */
  minPayoutCents: number;
  /** Hold (do not pay) recipients with a high-severity flag until a human reviews them. */
  holdFlagged: boolean;
}

export interface PrizePolicy {
  /** Pool split by placement, in basis points, 1st place first. Must sum to 10000. */
  placementBps: number[];
  minPayoutCents: number;
  holdFlagged: boolean;
}

export type FlagKind =
  | 'bot_sessions'
  | 'repeat_play_farming'
  | 'shared_payout_account'
  | 'report_spike'
  | 'suspicious_match';

export type Severity = 'medium' | 'high';

export interface Flag {
  /** Creator id, player id or team id the flag is about. */
  subjectId: string;
  kind: FlagKind;
  severity: Severity;
  evidence: Record<string, number | string>;
}

export type AllocationStatus = 'payable' | 'held' | 'below_minimum';

export interface Allocation {
  recipientId: string;
  payoutEmail: string;
  shareBps: number;
  amountCents: number;
  status: AllocationStatus;
  /** Machine-readable reasons; the agent turns them into prose. */
  reasons: string[];
}

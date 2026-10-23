import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Allocation, Flag, PrizePolicy, RevenueSharePolicy, Season, Tournament } from '../core/index.js';
import {
  DEFAULT_REVENUE_POLICY,
  detectSeasonAnomalies,
  generateSeason,
  generateTournament,
  splitRevenueShare,
} from '../core/index.js';
import type { ItemStatus } from '../paypal/payouts.js';

export type PoolId = string;

export interface FundEntry {
  id: string;
  at: string;
  poolId: PoolId;
  source: 'studio_deposit' | 'checkout' | 'sponsor_invoice';
  amountCents: number;
  ref: string;
  note: string;
}

export type RunStatus = 'draft' | 'approved' | 'submitted' | 'completed';

export interface RunItem {
  senderItemId: string;
  payoutItemId?: string;
  status: ItemStatus | 'NOT_SENT';
  errorName?: string;
  feeCents: number;
}

export interface Run {
  id: string;
  /** Globally unique; becomes PayPal's sender_batch_id, which can never be reused. */
  uid: string;
  kind: 'revenue_share' | 'prize_pool';
  poolId: PoolId;
  createdAt: string;
  policyText: string;
  policy: RevenueSharePolicy | PrizePolicy;
  defaulted: string[];
  flags: Flag[];
  allocations: Allocation[];
  unassignedCents: number;
  status: RunStatus;
  approval?: { by: string; at: string; digest: string };
  batch?: { batchId: string; senderBatchId: string; submittedAt: string; status: string };
  items: Record<string, RunItem>;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface Sponsor {
  id: string;
  name: string;
  email: string;
  poolId: PoolId;
  pledgeCents: number;
  status: 'pledged' | 'invoiced' | 'paid';
  invoiceId?: string;
  invoiceUrl?: string;
}

export interface State {
  season: Season;
  tournament: Tournament;
  fund: FundEntry[];
  sponsors: Sponsor[];
  runs: Run[];
  audit: AuditEntry[];
  /** Ids of PayPal webhook events already handled, newest last. */
  webhookEvents: string[];
}

/**
 * Points a few demo recipients at real PayPal sandbox personal accounts, so a
 * demo payout shows SUCCESS next to UNCLAIMED. Picks small amounts on purpose:
 * money sent to these accounts does not come back to the sandbox balance.
 */
export function useSandboxRecipients(season: Season, tournament: Tournament, emails: string[]): void {
  if (emails.length === 0) return;
  const queue = [...emails];
  // Cup: the 3rd-place team, the smallest paid place.
  const third = tournament.placements[2];
  for (const p of tournament.players.filter((x) => x.teamId === third)) {
    const email = queue.shift();
    if (email) p.payoutEmail = email;
  }
  // Season: the smallest shares that still clear the default minimum and are not flagged.
  const { allocations } = splitRevenueShare(season, DEFAULT_REVENUE_POLICY, detectSeasonAnomalies(season));
  const smallest = allocations
    .filter((a) => a.status === 'payable')
    .sort((a, b) => a.amountCents - b.amountCents)
    .slice(0, queue.length);
  for (const a of smallest) {
    const creator = season.creators.find((c) => c.id === a.recipientId);
    const email = queue.shift();
    if (creator && email) creator.payoutEmail = email;
  }
}

const sandboxRecipients = () =>
  (process.env.SANDBOX_RECIPIENTS ?? '').split(',').map((e) => e.trim()).filter(Boolean);

export function seedState(emails: string[] = sandboxRecipients()): State {
  const season = generateSeason();
  const tournament = generateTournament();
  useSandboxRecipients(season, tournament, emails);
  const at = new Date().toISOString();
  return {
    season,
    tournament,
    fund: [
      { id: 'fund_1', at, poolId: season.id, source: 'studio_deposit', amountCents: season.poolCents, ref: 'seed', note: 'Season 7 creator fund deposit' },
      { id: 'fund_2', at, poolId: tournament.id, source: 'studio_deposit', amountCents: tournament.poolCents / 2, ref: 'seed', note: 'Autumn Cup prize pool: studio half' },
    ],
    sponsors: [
      { id: 'sp_northwind', name: 'Northwind Peripherals', email: 'sponsor-northwind@example.com', poolId: tournament.id, pledgeCents: tournament.poolCents / 2, status: 'pledged' },
    ],
    runs: [],
    audit: [],
    webhookEvents: [],
  };
}

/** A tiny JSON-file store. Single process, synchronous writes, atomic rename. */
export class Store {
  private state: State;

  constructor(private readonly file: string | null) {
    const loaded = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Partial<State>) : undefined;
    // Files written by older versions lack newer fields; a fresh seed fills them in.
    this.state = loaded?.season ? { ...seedState(), ...loaded } as State : seedState();
    this.save();
  }

  get(): State {
    return this.state;
  }

  update<T>(fn: (s: State) => T): T {
    const out = fn(this.state);
    this.save();
    return out;
  }

  reset(): void {
    this.state = seedState();
    this.save();
  }

  audit(actor: string, action: string, detail: Record<string, unknown> = {}): void {
    this.update((s) => s.audit.push({ at: new Date().toISOString(), actor, action, detail }));
  }

  private save(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(this.state, null, 2));
    renameSync(`${this.file}.tmp`, this.file);
  }
}

export function fundedCents(state: State, poolId: PoolId): number {
  return state.fund.filter((f) => f.poolId === poolId).reduce((a, f) => a + f.amountCents, 0);
}

/** Money already committed to PayPal from this pool by earlier runs. */
export function paidOutCents(state: State, poolId: PoolId): number {
  return state.runs
    .filter((r) => r.poolId === poolId && (r.status === 'submitted' || r.status === 'completed'))
    .flatMap((r) => r.allocations.filter((a) => r.items[a.recipientId]?.status !== 'NOT_SENT'))
    .reduce((a, x) => a + x.amountCents, 0);
}

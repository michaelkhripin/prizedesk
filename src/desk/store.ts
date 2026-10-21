import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Allocation, Flag, PrizePolicy, RevenueSharePolicy, Season, Tournament } from '../core/index.js';
import { generateSeason, generateTournament } from '../core/index.js';
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

export interface State {
  season: Season;
  tournament: Tournament;
  fund: FundEntry[];
  runs: Run[];
  audit: AuditEntry[];
}

export function seedState(): State {
  const season = generateSeason();
  const tournament = generateTournament();
  const at = new Date().toISOString();
  return {
    season,
    tournament,
    fund: [
      { id: 'fund_1', at, poolId: season.id, source: 'studio_deposit', amountCents: season.poolCents, ref: 'seed', note: 'Season 7 creator fund deposit' },
      { id: 'fund_2', at, poolId: tournament.id, source: 'studio_deposit', amountCents: tournament.poolCents, ref: 'seed', note: 'Autumn Cup prize pool deposit' },
    ],
    runs: [],
    audit: [],
  };
}

/** A tiny JSON-file store. Single process, synchronous writes, atomic rename. */
export class Store {
  private state: State;

  constructor(private readonly file: string | null) {
    this.state = file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as State) : seedState();
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

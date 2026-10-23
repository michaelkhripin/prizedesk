import { createHash, randomUUID } from 'node:crypto';
import {
  detectSeasonAnomalies,
  detectTournamentAnomalies,
  parsePrizePolicyText,
  parseRevenuePolicyText,
  splitPrizePool,
  splitRevenueShare,
  validatePrizePolicy,
  validateRevenuePolicy,
  type Allocation,
  type PrizePolicy,
  type RevenueSharePolicy,
} from '../core/index.js';
import { createPayoutBatch, getPayoutBatch, type ItemStatus } from '../paypal/payouts.js';
import { fundedCents, paidOutCents, type Run, type State, type Store } from './store.js';

export class GuardrailError extends Error {}

export interface PayoutsApi {
  createPayoutBatch: typeof createPayoutBatch;
  getPayoutBatch: typeof getPayoutBatch;
}

const realPayouts: PayoutsApi = { createPayoutBatch, getPayoutBatch };

export const payable = (r: Run) => r.allocations.filter((a) => a.status === 'payable');
export const sumCents = (xs: Allocation[]) => xs.reduce((a, x) => a + x.amountCents, 0);

/** Fingerprint of exactly what a human approved: who gets paid, where, and how much. */
export function digest(r: Run): string {
  const rows = payable(r)
    .map((a) => `${a.recipientId}|${a.payoutEmail}|${a.amountCents}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(rows).digest('hex').slice(0, 16);
}

export type PolicyInput =
  | { kind: 'revenue_share'; text: string; policy?: RevenueSharePolicy }
  | { kind: 'prize_pool'; text: string; policy?: PrizePolicy };

/**
 * Builds a draft run from a written policy. When an LLM has already turned the
 * text into a structured policy it is passed in; otherwise the deterministic
 * parser reads the text. Either way the policy is validated before use.
 */
export function draftRun(store: Store, input: PolicyInput, actor: string): Run {
  return store.update((s) => {
    const id = `run_${s.runs.length + 1}`;
    const uid = randomUUID().replaceAll('-', '').slice(0, 20);
    const createdAt = new Date().toISOString();
    let run: Run;
    if (input.kind === 'revenue_share') {
      const parsed = input.policy
        ? { policy: validateRevenuePolicy(input.policy), defaulted: [] }
        : parseRevenuePolicyText(input.text);
      const flags = detectSeasonAnomalies(s.season);
      const split = splitRevenueShare(s.season, parsed.policy, flags);
      run = { id, uid, kind: input.kind, poolId: s.season.id, createdAt, policyText: input.text, policy: parsed.policy, defaulted: parsed.defaulted, flags, ...split, status: 'draft', items: {} };
    } else {
      const parsed = input.policy
        ? { policy: validatePrizePolicy(input.policy), defaulted: [] }
        : parsePrizePolicyText(input.text);
      const flags = detectTournamentAnomalies(s.tournament);
      const split = splitPrizePool(s.tournament, parsed.policy, flags);
      run = { id, uid, kind: input.kind, poolId: s.tournament.id, createdAt, policyText: input.text, policy: parsed.policy, defaulted: parsed.defaulted, flags, ...split, status: 'draft', items: {} };
    }
    s.runs.push(run);
    s.audit.push({ at: createdAt, actor, action: 'run.drafted', detail: { runId: id, kind: run.kind, payableCents: sumCents(payable(run)), flags: run.flags.length } });
    return run;
  });
}

export function getRun(state: State, runId: string): Run {
  const run = state.runs.find((r) => r.id === runId);
  if (!run) throw new GuardrailError(`unknown run ${runId}`);
  return run;
}

/** Only a person calls this; the agent has no tool for it. */
export function approveRun(store: Store, runId: string, approver: string): Run {
  if (!approver.trim()) throw new GuardrailError('approval needs the approver’s name');
  return store.update((s) => {
    const run = getRun(s, runId);
    if (run.status !== 'draft') throw new GuardrailError(`run is ${run.status}, only drafts can be approved`);
    if (payable(run).length === 0) throw new GuardrailError('nothing payable in this run');
    run.status = 'approved';
    run.approval = { by: approver, at: new Date().toISOString(), digest: digest(run) };
    s.audit.push({ at: run.approval.at, actor: `human:${approver}`, action: 'run.approved', detail: { runId, digest: run.approval.digest, payableCents: sumCents(payable(run)) } });
    return run;
  });
}

export function checkSubmittable(state: State, run: Run, maxBatchCents: number): void {
  if (run.status !== 'approved' || !run.approval) throw new GuardrailError('run must be approved by a person first');
  if (digest(run) !== run.approval.digest) throw new GuardrailError('run changed after approval; approve it again');
  const total = sumCents(payable(run));
  if (total > maxBatchCents) {
    throw new GuardrailError(`batch of $${(total / 100).toFixed(2)} exceeds the $${(maxBatchCents / 100).toFixed(2)} ceiling`);
  }
  const available = fundedCents(state, run.poolId) - paidOutCents(state, run.poolId);
  if (total > available) {
    throw new GuardrailError(`pool has $${(available / 100).toFixed(2)} available, batch needs $${(total / 100).toFixed(2)}`);
  }
}

export async function submitRun(store: Store, runId: string, maxBatchCents: number, api: PayoutsApi = realPayouts): Promise<Run> {
  const state = store.get();
  const run = getRun(state, runId);
  checkSubmittable(state, run, maxBatchCents);

  const items = payable(run).map((a, i) => ({
    senderItemId: `${run.id}_${i + 1}`,
    receiver: a.payoutEmail,
    amountCents: a.amountCents,
    note: run.kind === 'revenue_share' ? `${state.season.name}: your creator revenue share` : `${state.tournament.name}: your prize`,
    recipientId: a.recipientId,
  }));
  // Unique per draft: identical demo data must not collide with an earlier batch.
  const senderBatchId = `prizedesk_${run.uid ?? `${run.id}_${run.approval!.digest}`}`;
  const subject = run.kind === 'revenue_share' ? `Your ${state.season.name} payout` : `Your ${state.tournament.name} prize`;
  const res = await api.createPayoutBatch(senderBatchId, subject, items);

  return store.update((s) => {
    const r = getRun(s, runId);
    r.status = 'submitted';
    r.batch = { batchId: res.batchId, senderBatchId, submittedAt: new Date().toISOString(), status: res.status };
    for (const a of r.allocations) {
      const sent = items.find((i) => i.recipientId === a.recipientId);
      r.items[a.recipientId] = sent
        ? { senderItemId: sent.senderItemId, status: 'PENDING', feeCents: 0 }
        : { senderItemId: '', status: 'NOT_SENT', feeCents: 0 };
    }
    s.audit.push({ at: r.batch.submittedAt, actor: 'system', action: 'payouts.batch_created', detail: { runId, batchId: res.batchId, items: items.length, totalCents: sumCents(payable(r)) } });
    return r;
  });
}

const FINAL: ItemStatus[] = ['SUCCESS', 'FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'BLOCKED'];

export interface StatusChange {
  recipientId: string;
  from: string;
  to: ItemStatus;
  errorName?: string;
}

/** Pulls item statuses from PayPal (same data the PAYMENT.PAYOUTS-ITEM.* webhooks carry). */
export async function refreshRun(store: Store, runId: string, api: PayoutsApi = realPayouts): Promise<StatusChange[]> {
  const run = getRun(store.get(), runId);
  if (!run.batch) return [];
  const batch = await api.getPayoutBatch(run.batch.batchId);
  return store.update((s) => {
    const r = getRun(s, runId);
    r.batch!.status = batch.status;
    const changes: StatusChange[] = [];
    for (const [recipientId, item] of Object.entries(r.items)) {
      const fresh = batch.items.find((b) => b.senderItemId === item.senderItemId);
      if (!fresh) continue;
      if (fresh.status !== item.status) changes.push({ recipientId, from: item.status, to: fresh.status, errorName: fresh.errorName });
      Object.assign(item, { payoutItemId: fresh.payoutItemId, status: fresh.status, errorName: fresh.errorName, feeCents: fresh.feeCents });
    }
    const open = Object.values(r.items).filter((i) => i.status !== 'NOT_SENT' && !FINAL.includes(i.status as ItemStatus) && i.status !== 'UNCLAIMED');
    if (open.length === 0) r.status = 'completed';
    for (const c of changes) {
      s.audit.push({ at: new Date().toISOString(), actor: 'paypal', action: `payouts.item_${c.to.toLowerCase()}`, detail: { runId, ...c } });
    }
    return changes;
  });
}

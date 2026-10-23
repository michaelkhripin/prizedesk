import { describe, expect, it } from 'vitest';
import { Store } from './store.js';
import { GuardrailError, approveRun, draftRun, payable, refreshRun, submitRun, sumCents, type PayoutsApi } from './runs.js';

const POLICY = '70% by engaged playtime, 30% by unique players, cap each creator at 25%, minimum payout $10, hold anyone flagged';

function fakePayouts(final: Record<string, 'SUCCESS' | 'UNCLAIMED' | 'FAILED'> = {}) {
  const calls: { senderBatchId: string; items: number }[] = [];
  let sent: { senderItemId: string; receiver: string }[] = [];
  const api: PayoutsApi = {
    async createPayoutBatch(senderBatchId, _subject, items) {
      calls.push({ senderBatchId, items: items.length });
      sent = items;
      return { batchId: 'BATCH1', status: 'PENDING' };
    },
    async getPayoutBatch(batchId) {
      return {
        batchId,
        status: 'SUCCESS',
        items: sent.map((i, k) => ({
          payoutItemId: `ITEM${k}`,
          senderItemId: i.senderItemId,
          status: final[i.receiver] ?? 'SUCCESS',
          feeCents: 25,
        })),
      };
    },
  };
  return { api, calls };
}

describe('payout runs', () => {
  it('drafts a run with flags and holds', () => {
    const store = new Store(null);
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    expect(run.status).toBe('draft');
    expect(run.flags.length).toBeGreaterThan(0);
    expect(run.allocations.some((a) => a.status === 'held')).toBe(true);
  });

  it('refuses to submit without a human approval', async () => {
    const store = new Store(null);
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    await expect(submitRun(store, run.id, 3_000_000, fakePayouts().api)).rejects.toThrow(GuardrailError);
  });

  it('refuses a batch above the ceiling', async () => {
    const store = new Store(null);
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, run.id, 'Michael');
    await expect(submitRun(store, run.id, 1_000_00, fakePayouts().api)).rejects.toThrow(/ceiling/);
  });

  it('refuses when the approved amounts were changed afterwards', async () => {
    const store = new Store(null);
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, run.id, 'Michael');
    store.update((s) => { s.runs[0]!.allocations.find((a) => a.status === 'payable')!.amountCents += 100; });
    await expect(submitRun(store, run.id, 3_000_000, fakePayouts().api)).rejects.toThrow(/changed after approval/);
  });

  it('refuses to pay more than the pool holds', async () => {
    const store = new Store(null);
    store.update((s) => { s.fund = s.fund.filter((f) => f.poolId !== s.season.id); });
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, run.id, 'Michael');
    await expect(submitRun(store, run.id, 3_000_000, fakePayouts().api)).rejects.toThrow(/pool has/);
  });

  it('pays only payable recipients, then tracks statuses', async () => {
    const store = new Store(null);
    const run = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, run.id, 'Michael');
    const firstEmail = payable(run)[0]!.payoutEmail;
    const { api, calls } = fakePayouts({ [firstEmail]: 'UNCLAIMED' });
    const submitted = await submitRun(store, run.id, 3_000_000, api);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.items).toBe(payable(run).length);
    expect(Object.values(submitted.items).filter((i) => i.status === 'NOT_SENT')).toHaveLength(
      run.allocations.length - payable(run).length,
    );
    const changes = await refreshRun(store, run.id, api);
    expect(changes.filter((c) => c.to === 'UNCLAIMED')).toHaveLength(1);
    expect(store.get().runs[0]!.status).toBe('completed');
    expect(store.get().audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(['run.drafted', 'run.approved', 'payouts.batch_created', 'payouts.item_unclaimed']),
    );
  });

  it('counts paid-out money against the pool for the next run', async () => {
    const store = new Store(null);
    const first = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, first.id, 'Michael');
    await submitRun(store, first.id, 3_000_000, fakePayouts().api);
    const second = draftRun(store, { kind: 'revenue_share', text: POLICY }, 'agent');
    approveRun(store, second.id, 'Michael');
    expect(sumCents(payable(second))).toBeGreaterThan(0);
    await expect(submitRun(store, second.id, 3_000_000, fakePayouts().api)).rejects.toThrow(/pool has/);
  });

  it('gives identical drafts on different desks different PayPal batch ids', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const store = new Store(null);
      const run = draftRun(store, { kind: 'prize_pool', text: '50/30/20' }, 'agent');
      approveRun(store, run.id, 'Michael');
      const { api, calls } = fakePayouts();
      await submitRun(store, run.id, 3_000_000, api);
      ids.push(calls[0]!.senderBatchId);
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});

describe('sandbox recipients', () => {
  it('maps real sandbox accounts onto the 3rd-place team and small season shares, without new fraud flags', async () => {
    const { seedState } = await import('./store.js');
    const { detectSeasonAnomalies, detectTournamentAnomalies } = await import('../core/index.js');
    const emails = ['a@personal.example.com', 'b@personal.example.com', 'c@personal.example.com', 'd@personal.example.com', 'e@personal.example.com'];
    const s = seedState(emails);
    const third = s.tournament.players.filter((p) => p.teamId === s.tournament.placements[2]);
    expect(third.map((p) => p.payoutEmail)).toEqual(emails.slice(0, 3));
    expect(s.season.creators.filter((c) => emails.includes(c.payoutEmail))).toHaveLength(2);
    expect(detectSeasonAnomalies(s.season)).toEqual(detectSeasonAnomalies(seedState([]).season));
    expect(detectTournamentAnomalies(s.tournament)).toEqual(detectTournamentAnomalies(seedState([]).tournament));
  });
});

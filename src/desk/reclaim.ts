import { cancelUnclaimedItem } from '../paypal/payouts.js';
import { usd } from './explain.js';
import { GuardrailError, getRun } from './runs.js';
import type { Store } from './store.js';

export type CancelApi = (payoutItemId: string) => Promise<string>;

/**
 * Pulls back one unclaimed payout so it can be re-sent to a corrected address.
 * Only a person (or the demo's housekeeping) calls this; the agent cannot.
 */
export async function cancelUnclaimed(store: Store, runId: string, recipientId: string, actor: string, cancel: CancelApi = cancelUnclaimedItem) {
  const run = getRun(store.get(), runId);
  const item = run.items[recipientId];
  if (!item?.payoutItemId || item.status !== 'UNCLAIMED') throw new GuardrailError('only unclaimed payouts can be pulled back');
  const status = await cancel(item.payoutItemId);
  const amount = run.allocations.find((a) => a.recipientId === recipientId)?.amountCents ?? 0;
  store.update((s) => {
    const it = getRun(s, runId).items[recipientId]!;
    it.status = status as typeof it.status;
    s.audit.push({ at: new Date().toISOString(), actor, action: 'payouts.item_cancelled', detail: { runId, recipientId, amount: usd(amount), status } });
  });
  return { recipientId, status };
}

/** Pulls back every unclaimed payout older than `olderThanMs`. Used to recycle sandbox test money in the hosted demo. */
export async function reclaimStale(store: Store, olderThanMs: number, cancel: CancelApi = cancelUnclaimedItem) {
  const cutoff = Date.now() - olderThanMs;
  const done: { runId: string; recipientId: string; status: string }[] = [];
  for (const run of store.get().runs) {
    if (!run.batch || Date.parse(run.batch.submittedAt) > cutoff) continue;
    for (const [recipientId, item] of Object.entries(run.items)) {
      if (item.status !== 'UNCLAIMED' || !item.payoutItemId) continue;
      try {
        done.push({ runId: run.id, ...(await cancelUnclaimed(store, run.id, recipientId, 'system:demo-housekeeping', cancel)) });
      } catch {
        // Already claimed, returned or cancelled meanwhile: nothing to recycle.
      }
    }
  }
  return done;
}

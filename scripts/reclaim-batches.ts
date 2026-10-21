// Pulls back unclaimed sandbox payouts by batch id: npm run sandbox:reclaim -- BATCH_ID [...]
import { cancelUnclaimedItem, getPayoutBatch } from '../src/paypal/payouts.js';

let total = 0;
for (const batchId of process.argv.slice(2)) {
  const batch = await getPayoutBatch(batchId);
  for (const item of batch.items.filter((i) => i.status === 'UNCLAIMED')) {
    try {
      const status = await cancelUnclaimedItem(item.payoutItemId);
      total++;
      console.log(`${batchId} ${item.senderItemId}: ${status}`);
    } catch (e) {
      console.log(`${batchId} ${item.senderItemId}: failed (${(e as Error).message}), rerun later`);
    }
  }
}
console.log(`pulled back ${total} unclaimed payout(s)`);

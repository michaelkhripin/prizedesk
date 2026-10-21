// End-to-end on the PayPal sandbox: draft -> approve -> Payouts batch -> status.
// Uses test money only. Run: npm run e2e:sandbox
import { config, paypalConfigured } from '../src/config.js';
import { approveRun, draftRun, payable, refreshRun, submitRun, sumCents } from '../src/desk/runs.js';
import { Store } from '../src/desk/store.js';
import { usd } from '../src/desk/explain.js';

if (!paypalConfigured()) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET missing in .env');
const store = new Store(null);
const run = draftRun(store, { kind: 'prize_pool', text: '50/30/20, hold flagged teams, minimum $1' }, 'e2e');
console.log(`drafted ${run.id}: ${usd(sumCents(payable(run)))} payable to ${payable(run).length}, held ${run.allocations.filter((a) => a.status === 'held').length}`);
approveRun(store, run.id, 'e2e-script');
const submitted = await submitRun(store, run.id, config.maxBatchCents);
console.log(`submitted: PayPal batch ${submitted.batch!.batchId} (${submitted.batch!.status})`);
for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const changes = await refreshRun(store, run.id);
  const r = store.get().runs[0]!;
  const counts: Record<string, number> = {};
  for (const it of Object.values(r.items)) counts[it.status] = (counts[it.status] ?? 0) + 1;
  console.log(`poll ${i + 1}: batch ${r.batch!.status}, ${JSON.stringify(counts)}, ${changes.length} changed`);
  if (r.status === 'completed') break;
}
console.log('audit:', store.get().audit.map((a) => a.action).join(' -> '));

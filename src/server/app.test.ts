import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockLLM } from '../agent/mock.js';
import type { PayoutsApi } from '../desk/runs.js';
import { Store } from '../desk/store.js';
import { createApp } from './app.js';
import { perVisitorDesks, sharedDesk } from './desks.js';

const payouts: PayoutsApi = {
  createPayoutBatch: async () => ({ batchId: 'B1', status: 'PENDING' }),
  getPayoutBatch: async (batchId) => ({ batchId, status: 'SUCCESS', items: [] }),
};

function setup(verify = async () => true) {
  const store = new Store(null);
  const app = createApp({
    desks: sharedDesk(store),
    webhook: { id: 'WH-TEST', verify },
    llm: new MockLLM(),
    maxBatchCents: 30_000_00,
    payouts,
    checkout: {
      createOrder: async () => ({ orderId: 'O1', status: 'CREATED' }),
      captureOrder: async (orderId) => ({ orderId, status: 'COMPLETED', referenceId: 'supporter', captureId: 'C1', amountCents: 9_99 }),
    },
    publicConfig: { llm: 'mock' },
  });
  return { app, store };
}

describe('API', () => {
  it('runs the human path: agent drafts, person approves, then submits', async () => {
    const { app } = setup();
    const chat = await request(app).post('/api/agent').send({ message: 'Draft prize split 50/30/20, hold flagged' });
    expect(chat.status).toBe(200);
    expect(chat.body.actions[0].tool).toBe('draft_payout_run');

    expect((await request(app).post('/api/runs/run_1/submit')).status).toBe(409);
    expect((await request(app).post('/api/runs/run_1/approve').send({})).status).toBe(409);
    expect((await request(app).post('/api/runs/run_1/approve').send({ approver: 'Michael' })).body.status).toBe('approved');
    const submitted = await request(app).post('/api/runs/run_1/submit');
    expect(submitted.body.batch.batchId).toBe('B1');

    const state = await request(app).get('/api/state');
    expect(state.body.runs[0].view.summary).toMatch(/Draft run_1/);
    expect(state.body.pools[1].paidOutCents).toBeGreaterThan(0);
  });

  it('adds half of a captured supporter pack to the creator fund, once', async () => {
    const { app, store } = setup();
    const before = store.get().fund.length;
    await request(app).post('/api/checkout/orders/O1/capture');
    await request(app).post('/api/checkout/orders/O1/capture');
    const fund = store.get().fund;
    expect(fund).toHaveLength(before + 1);
    expect(fund.at(-1)!.amountCents).toBe(4_99);
  });

  it('accepts only verified webhooks, once each, and refreshes the matching run', async () => {
    const { app, store } = setup();
    await request(app).post('/api/agent').send({ message: 'Draft prize split 50/30/20, hold flagged' });
    await request(app).post('/api/runs/run_1/approve').send({ approver: 'Michael' });
    await request(app).post('/api/runs/run_1/submit');
    const event = { id: 'WH-EVT-1', event_type: 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', resource: { payout_batch_id: 'B1' } };
    const first = await request(app).post('/api/webhooks/paypal').send(event);
    expect(first.body).toMatchObject({ ok: true, run: 'run_1' });
    expect((await request(app).post('/api/webhooks/paypal').send(event)).body.duplicate).toBe(true);
    expect(store.get().audit.filter((a) => a.action === 'webhook.received')).toHaveLength(1);

    const forged = setup(async () => false);
    expect((await request(forged.app).post('/api/webhooks/paypal').send(event)).status).toBe(409);
  });

  it('gives every demo visitor a private desk and rate-limits the agent', async () => {
    const app = createApp({ desks: perVisitorDesks(), demo: true, llm: new MockLLM(), maxBatchCents: 30_000_00, payouts, publicConfig: {} });
    const a = request.agent(app);
    const b = request.agent(app);
    await a.post('/api/agent').send({ message: 'Draft prize split 50/30/20' });
    expect((await a.get('/api/state')).body.runs).toHaveLength(1);
    expect((await b.get('/api/state')).body.runs).toHaveLength(0);
    let status = 200;
    for (let i = 0; i < 31 && status === 200; i++) status = (await b.post('/api/agent').send({ message: 'overview' })).status;
    expect(status).toBe(429);
  });

  it('lets a person pull back an unclaimed payout, and nothing else', async () => {
    const store = new Store(null);
    const unclaimed: PayoutsApi = {
      createPayoutBatch: async () => ({ batchId: 'B2', status: 'PENDING' }),
      getPayoutBatch: async (batchId) => ({
        batchId,
        status: 'SUCCESS',
        items: Object.values(store.get().runs[0]!.items).filter((i) => i.senderItemId).map((i, k) => ({ payoutItemId: `IT${k}`, senderItemId: i.senderItemId, status: 'UNCLAIMED' as const, feeCents: 25 })),
      }),
    };
    const app = createApp({ desks: sharedDesk(store), llm: new MockLLM(), maxBatchCents: 30_000_00, payouts: unclaimed, cancelItem: async () => 'RETURNED', publicConfig: {} });
    await request(app).post('/api/agent').send({ message: 'Draft prize split 50/30/20, hold flagged' });
    await request(app).post('/api/runs/run_1/approve').send({ approver: 'Michael' });
    await request(app).post('/api/runs/run_1/submit');
    await request(app).post('/api/runs/run_1/refresh');
    const paid = Object.entries(store.get().runs[0]!.items).find(([, i]) => i.status === 'UNCLAIMED')![0];
    const held = Object.entries(store.get().runs[0]!.items).find(([, i]) => i.status === 'NOT_SENT')![0];
    expect((await request(app).post(`/api/runs/run_1/items/${paid}/cancel`).send({})).status).toBe(409);
    expect((await request(app).post(`/api/runs/run_1/items/${paid}/cancel`).send({ by: 'Michael' })).body.status).toBe('RETURNED');
    expect((await request(app).post(`/api/runs/run_1/items/${held}/cancel`).send({ by: 'Michael' })).status).toBe(409);
  });
});

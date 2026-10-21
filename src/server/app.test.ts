import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockLLM } from '../agent/mock.js';
import type { PayoutsApi } from '../desk/runs.js';
import { Store } from '../desk/store.js';
import { createApp } from './app.js';

const payouts: PayoutsApi = {
  createPayoutBatch: async () => ({ batchId: 'B1', status: 'PENDING' }),
  getPayoutBatch: async (batchId) => ({ batchId, status: 'SUCCESS', items: [] }),
};

function setup() {
  const store = new Store(null);
  const app = createApp({
    store,
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
});

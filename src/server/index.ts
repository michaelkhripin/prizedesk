import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { GeminiLLM } from '../agent/gemini.js';
import type { LLM } from '../agent/llm.js';
import { FallbackLLM } from '../agent/fallback.js';
import { MockLLM } from '../agent/mock.js';
import type { ToolContext } from '../agent/tools.js';
import { config, paypalConfigured } from '../config.js';
import { toolkitInvoicing } from '../desk/sponsors.js';
import { Store } from '../desk/store.js';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { perVisitorDesks, sharedDesk } from './desks.js';
import { reclaimStale } from '../desk/reclaim.js';

const llm: LLM =
  config.llm.provider === 'gemini' && config.llm.geminiKey
    ? new FallbackLLM(new GeminiLLM(config.llm.geminiKey, config.llm.geminiModels), new MockLLM())
    : new MockLLM();

const toolkitTools = paypalConfigured()
  ? (new PayPalAgentToolkit({
      clientId: config.paypal.clientId,
      clientSecret: config.paypal.clientSecret,
      configuration: {
        actions: { invoices: { create: true, send: true, get: true, recordPayment: true }, transactions: { list: true } },
        context: { sandbox: !config.paypal.baseUrl.includes('api-m.paypal.com') },
      },
    }).getTools() as unknown as NonNullable<ToolContext['paypalTools']>)
  : undefined;
// The agent sees only read-only toolkit tools; invoices go through PrizeDesk's own guarded workflow.
const paypalTools = toolkitTools && { get_invoice: toolkitTools.get_invoice!, list_transactions: toolkitTools.list_transactions! };
const invoicing = toolkitTools && toolkitInvoicing(toolkitTools);

const demo = process.env.DEMO_MODE === '1';
const desks = demo ? perVisitorDesks() : sharedDesk(new Store(config.dataFile));

const app = createApp({
  desks,
  demo,
  llm,
  maxBatchCents: config.maxBatchCents,
  paypalTools,
  invoicing,
  webhook: process.env.PAYPAL_WEBHOOK_ID ? { id: process.env.PAYPAL_WEBHOOK_ID } : undefined,
  staticDir: existsSync('dist/web/index.html') ? 'dist/web' : undefined,
  publicConfig: {
    paypalClientId: config.paypal.clientId,
    paypalConfigured: paypalConfigured(),
    llm: llm.name,
    demo,
    maxBatchUsd: config.maxBatchCents / 100,
  },
});

if (demo && paypalConfigured()) {
  // Recycle sandbox test money: pull back demo payouts nobody can claim (@example.com recipients).
  const after = Number(process.env.RECLAIM_AFTER_MIN ?? 60) * 60_000;
  setInterval(() => {
    for (const store of desks.all()) reclaimStale(store, after).catch((e) => console.error('reclaim failed', e));
  }, 10 * 60_000).unref();
}

app.set('trust proxy', 1);
app.listen(config.port, () => {
  console.log(`PrizeDesk API on http://localhost:${config.port} (llm: ${llm.name}, paypal: ${paypalConfigured() ? 'sandbox' : 'not configured'})`);
});

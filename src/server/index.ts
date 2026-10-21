import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { GeminiLLM } from '../agent/gemini.js';
import type { LLM } from '../agent/llm.js';
import { MockLLM } from '../agent/mock.js';
import type { ToolContext } from '../agent/tools.js';
import { config, paypalConfigured } from '../config.js';
import { Store } from '../desk/store.js';
import { existsSync } from 'node:fs';
import { createApp } from './app.js';

const llm: LLM =
  config.llm.provider === 'gemini' && config.llm.geminiKey
    ? new GeminiLLM(config.llm.geminiKey, config.llm.geminiModels)
    : new MockLLM();

const paypalTools = paypalConfigured()
  ? (new PayPalAgentToolkit({
      clientId: config.paypal.clientId,
      clientSecret: config.paypal.clientSecret,
      configuration: {
        actions: { invoices: { create: true, send: true, get: true, list: true }, transactions: { list: true } },
        context: { sandbox: !config.paypal.baseUrl.includes('api-m.paypal.com') },
      },
    }).getTools() as unknown as ToolContext['paypalTools'])
  : undefined;

const app = createApp({
  store: new Store(config.dataFile),
  llm,
  maxBatchCents: config.maxBatchCents,
  paypalTools,
  staticDir: existsSync('dist/web/index.html') ? 'dist/web' : undefined,
  publicConfig: {
    paypalClientId: config.paypal.clientId,
    paypalConfigured: paypalConfigured(),
    llm: llm.name,
    maxBatchUsd: config.maxBatchCents / 100,
  },
});

app.listen(config.port, () => {
  console.log(`PrizeDesk API on http://localhost:${config.port} (llm: ${llm.name}, paypal: ${paypalConfigured() ? 'sandbox' : 'not configured'})`);
});

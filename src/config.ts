import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const config = {
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID ?? '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
    baseUrl:
      process.env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
  },
  llm: {
    provider: (process.env.LLM_PROVIDER ?? 'mock') as 'mock' | 'gemini',
    geminiKey: process.env.GEMINI_API_KEY ?? '',
    geminiModels: (process.env.GEMINI_MODELS ?? 'gemini-flash-latest,gemini-3-flash-preview').split(','),
  },
  maxBatchCents: Math.round(num('MAX_BATCH_USD', 30_000) * 100),
  dataFile: process.env.PRIZEDESK_DATA ?? 'data/state.json',
  // API_PORT wins so a dev preview's PORT (meant for Vite) does not move the API.
  port: num('API_PORT', num('PORT', 8787)),
};

export const paypalConfigured = () => Boolean(config.paypal.clientId && config.paypal.clientSecret);

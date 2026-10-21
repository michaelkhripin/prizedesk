import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../agent/agent.js';
import type { LLM, Message } from '../agent/llm.js';
import { runSummary, type ToolContext } from '../agent/tools.js';
import { usd } from '../desk/explain.js';
import { GuardrailError, approveRun, getRun, refreshRun, submitRun, type PayoutsApi } from '../desk/runs.js';
import { fundedCents, paidOutCents, type Store } from '../desk/store.js';
import { PayPalError } from '../paypal/client.js';
import { captureOrder, createOrder } from '../paypal/orders.js';

export interface AppDeps {
  store: Store;
  llm: LLM;
  maxBatchCents: number;
  payouts?: PayoutsApi;
  paypalTools?: ToolContext['paypalTools'];
  checkout?: { createOrder: typeof createOrder; captureOrder: typeof captureOrder };
  publicConfig: Record<string, unknown>;
  /** Built web UI to serve in production (`npm run build`). */
  staticDir?: string;
}

/** Supporter packs players can buy; part of each sale feeds the creator fund. */
export const PACKS = {
  supporter: { name: 'Season 7 Supporter Pack', priceCents: 9_99, toFundBps: 5000 },
  champion: { name: 'Season 7 Champion Pack', priceCents: 24_99, toFundBps: 5000 },
} as const;

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  (req: Request, res: Response, next: NextFunction) =>
    Promise.resolve(fn(req, res)).then((body) => res.json(body), next);

export function createApp(deps: AppDeps) {
  const { store } = deps;
  const ctx: ToolContext = { store, payouts: deps.payouts, paypalTools: deps.paypalTools };
  const checkout = deps.checkout ?? { createOrder, captureOrder };
  const sessions = new Map<string, Message[]>();
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/config', (_req, res) => res.json(deps.publicConfig));

  app.get(
    '/api/state',
    wrap(() => {
      const s = store.get();
      const pool = (id: string, name: string, target: number) => ({
        id, name, targetCents: target, fundedCents: fundedCents(s, id), paidOutCents: paidOutCents(s, id),
      });
      return {
        pools: [pool(s.season.id, s.season.name, s.season.poolCents), pool(s.tournament.id, s.tournament.name, s.tournament.poolCents)],
        season: s.season,
        tournament: s.tournament,
        fund: s.fund,
        runs: s.runs.map((r) => ({ ...r, view: runSummary(s, r) })),
        audit: s.audit.slice(-200),
      };
    }),
  );

  app.post(
    '/api/agent',
    wrap(async (req) => {
      const message = String(req.body?.message ?? '').trim();
      if (!message) throw new GuardrailError('message is empty');
      const sessionId = String(req.body?.sessionId ?? randomUUID());
      const out = await runAgent(deps.llm, ctx, sessions.get(sessionId) ?? [], message);
      // Keep the last 30 turns per session; enough context for a demo, bounded memory.
      sessions.set(sessionId, out.messages.slice(-30));
      return { sessionId, reply: out.reply, actions: out.actions, model: out.model };
    }),
  );

  app.post('/api/runs/:id/approve', wrap((req) => approveRun(store, req.params.id!, String(req.body?.approver ?? ''))));
  app.post(
    '/api/runs/:id/submit',
    wrap((req) => submitRun(store, req.params.id!, deps.maxBatchCents, deps.payouts)),
  );
  app.post(
    '/api/runs/:id/refresh',
    wrap(async (req) => ({ changes: await refreshRun(store, req.params.id!, deps.payouts), run: getRun(store.get(), req.params.id!) })),
  );

  app.post(
    '/api/checkout/orders',
    wrap(async (req) => {
      const pack = PACKS[String(req.body?.pack) as keyof typeof PACKS];
      if (!pack) throw new GuardrailError('unknown pack');
      return checkout.createOrder(pack.priceCents, pack.name, String(req.body?.pack));
    }),
  );
  app.post(
    '/api/checkout/orders/:id/capture',
    wrap(async (req) => {
      const cap = await checkout.captureOrder(req.params.id!);
      if (cap.status !== 'COMPLETED') return cap;
      const pack = PACKS[cap.referenceId as keyof typeof PACKS];
      const toFund = Math.floor((cap.amountCents * (pack?.toFundBps ?? 0)) / 10000);
      store.update((s) => {
        if (s.fund.some((f) => f.ref === cap.captureId)) return;
        s.fund.push({
          id: `fund_${s.fund.length + 1}`, at: new Date().toISOString(), poolId: s.season.id, source: 'checkout',
          amountCents: toFund, ref: cap.captureId ?? cap.orderId, note: `${pack?.name ?? 'Pack'}: ${usd(toFund)} of ${usd(cap.amountCents)} to the creator fund`,
        });
      });
      store.audit('paypal', 'checkout.captured', { orderId: cap.orderId, amountCents: cap.amountCents, toFundCents: toFund });
      return { ...cap, toFundCents: toFund };
    }),
  );

  app.post('/api/reset', wrap(() => (store.reset(), sessions.clear(), { ok: true })));

  if (deps.staticDir) {
    const dir = deps.staticDir;
    app.use(express.static(dir));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dir }));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GuardrailError) return res.status(409).json({ error: err.message, guardrail: true });
    if (err instanceof PayPalError) return res.status(502).json({ error: `PayPal: ${err.message}`, name: err.name });
    if (err instanceof Error && err.name === 'ZodError') return res.status(400).json({ error: err.message });
    console.error(err);
    return res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });
  return app;
}

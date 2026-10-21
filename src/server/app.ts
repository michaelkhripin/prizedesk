import express, { type NextFunction, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { runAgent } from '../agent/agent.js';
import type { LLM, Message } from '../agent/llm.js';
import { runSummary, type ToolContext } from '../agent/tools.js';
import { usd } from '../desk/explain.js';
import { GuardrailError, approveRun, getRun, refreshRun, submitRun, type PayoutsApi } from '../desk/runs.js';
import { invoiceSponsor, recordSponsorPayment, syncSponsorInvoice, type InvoicingApi } from '../desk/sponsors.js';
import { cancelUnclaimed } from '../desk/reclaim.js';
import { fundedCents, paidOutCents, type Store } from '../desk/store.js';
import { eventTarget, verifyWebhook, type WebhookEvent } from '../paypal/webhooks.js';
import { PayPalError } from '../paypal/client.js';
import { captureOrder, createOrder } from '../paypal/orders.js';
import { cancelUnclaimedItem } from '../paypal/payouts.js';
import { rateLimit, sharedDesk, type Desks } from './desks.js';

export interface AppDeps {
  /** One shared desk, or a desk per visitor in the hosted demo. */
  desks: Desks;
  /** Hosted demo: per-route rate limits. */
  demo?: boolean;
  cancelItem?: typeof cancelUnclaimedItem;
  llm: LLM;
  maxBatchCents: number;
  payouts?: PayoutsApi;
  invoicing?: InvoicingApi;
  /** Read-only PayPal Agent Toolkit tools exposed to the agent. */
  paypalTools?: ToolContext['paypalTools'];
  webhook?: { id: string; verify?: typeof verifyWebhook };
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

type Handler = (req: Request, store: Store) => Promise<unknown> | unknown;

/** Resolves the caller's desk, runs the handler, and sends its result as JSON. */
const route =
  (desks: Desks, fn: Handler) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const store = desks.forRequest(req, res);
      Promise.resolve(fn(req, store)).then((body) => res.json(body), next);
    } catch (e) {
      next(e);
    }
  };

export function createApp(deps: AppDeps) {
  const { desks } = deps;
  const ctxFor = (store: Store): ToolContext => ({ store, payouts: deps.payouts, invoicing: deps.invoicing, paypalTools: deps.paypalTools });
  const limit = (n: number, minutes: number) =>
    deps.demo ? rateLimit(n, minutes * 60_000) : (_req: Request, _res: Response, next: NextFunction) => next();
  const invoicing = () => {
    if (!deps.invoicing) throw new GuardrailError('PayPal is not configured');
    return deps.invoicing;
  };
  const checkout = deps.checkout ?? { createOrder, captureOrder };
  const sessions = new Map<string, Message[]>();
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.get('/api/config', (_req, res) => res.json(deps.publicConfig));

  app.get(
    '/api/state',
    route(desks, (_req, store) => {
      const s = store.get();
      const pool = (id: string, name: string, target: number) => ({
        id, name, targetCents: target, fundedCents: fundedCents(s, id), paidOutCents: paidOutCents(s, id),
      });
      return {
        pools: [pool(s.season.id, s.season.name, s.season.poolCents), pool(s.tournament.id, s.tournament.name, s.tournament.poolCents)],
        season: s.season,
        tournament: s.tournament,
        fund: s.fund,
        sponsors: s.sponsors,
        runs: s.runs.map((r) => ({ ...r, view: runSummary(s, r) })),
        audit: s.audit.slice(-200),
      };
    }),
  );

  app.post(
    '/api/agent',
    limit(30, 10),
    route(desks, async (req, store) => {
      const message = String(req.body?.message ?? '').trim();
      if (!message) throw new GuardrailError('message is empty');
      const sessionId = String(req.body?.sessionId ?? randomUUID());
      const out = await runAgent(deps.llm, ctxFor(store), sessions.get(sessionId) ?? [], message);
      // Keep the last 30 turns per session; enough context for a demo, bounded memory.
      sessions.set(sessionId, out.messages.slice(-30));
      if (sessions.size > 1000) sessions.delete(sessions.keys().next().value!);
      return { sessionId, reply: out.reply, actions: out.actions, model: out.model };
    }),
  );

  app.post('/api/runs/:id/approve', route(desks, (req, store) => approveRun(store, req.params.id!, String(req.body?.approver ?? ''))));
  app.post(
    '/api/runs/:id/submit',
    limit(6, 60),
    route(desks, (req, store) => submitRun(store, req.params.id!, deps.maxBatchCents, deps.payouts)),
  );
  app.post(
    '/api/runs/:id/refresh',
    limit(60, 10),
    route(desks, async (req, store) => ({ changes: await refreshRun(store, req.params.id!, deps.payouts), run: getRun(store.get(), req.params.id!) })),
  );
  app.post(
    '/api/runs/:id/items/:recipient/cancel',
    route(desks, (req, store) => {
      const by = String(req.body?.by ?? '').trim();
      if (!by) throw new GuardrailError('pulling back a payout needs your name');
      return cancelUnclaimed(store, req.params.id!, req.params.recipient!, `human:${by}`, deps.cancelItem);
    }),
  );

  app.post('/api/sponsors/:id/invoice', limit(4, 60), route(desks, (req, store) => invoiceSponsor(store, invoicing(), req.params.id!, `human:${String(req.body?.by ?? 'studio')}`)));
  app.post('/api/sponsors/:id/check', limit(30, 10), route(desks, (req, store) => syncSponsorInvoice(store, invoicing(), req.params.id!, 'studio')));
  app.post('/api/sponsors/:id/record-payment', limit(4, 60), route(desks, (req, store) => recordSponsorPayment(store, invoicing(), req.params.id!, String(req.body?.by ?? ''))));

  // PayPal calls this, not a visitor, so it looks for the run or invoice across every desk.
  app.post('/api/webhooks/paypal', (req, res, next) => {
    (async () => {
      if (!deps.webhook?.id) throw new GuardrailError('webhooks are not configured (PAYPAL_WEBHOOK_ID)');
      const event = req.body as WebhookEvent;
      const verify = deps.webhook.verify ?? verifyWebhook;
      if (!(await verify(req.headers, event, deps.webhook.id))) throw new GuardrailError('webhook signature rejected');
      const { batchId, invoiceId } = eventTarget(event);
      const handled: { run?: string; invoice?: string; duplicate?: boolean } = {};
      for (const store of desks.all()) {
        const s = store.get();
        const run = batchId ? s.runs.find((r) => r.batch?.batchId === batchId) : undefined;
        const sponsor = invoiceId ? s.sponsors.find((sp) => sp.invoiceId === invoiceId) : undefined;
        if (!run && !sponsor) continue;
        if (s.webhookEvents.includes(event.id)) {
          handled.duplicate = true;
          continue;
        }
        store.update((st) => {
          st.webhookEvents = [...st.webhookEvents, event.id].slice(-500);
        });
        store.audit('paypal', 'webhook.received', { type: event.event_type, id: event.id });
        if (run) {
          await refreshRun(store, run.id, deps.payouts);
          handled.run = run.id;
        }
        if (sponsor) {
          await syncSponsorInvoice(store, invoicing(), invoiceId!, 'paypal');
          handled.invoice = invoiceId;
        }
      }
      return { ok: true, ...handled };
    })().then((body) => res.json(body), next);
  });

  app.post(
    '/api/checkout/orders',
    limit(20, 60),
    route(desks, async (req) => {
      const pack = PACKS[String(req.body?.pack) as keyof typeof PACKS];
      if (!pack) throw new GuardrailError('unknown pack');
      return checkout.createOrder(pack.priceCents, pack.name, String(req.body?.pack));
    }),
  );
  app.post(
    '/api/checkout/orders/:id/capture',
    route(desks, async (req, store) => {
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

  app.post('/api/reset', limit(10, 60), route(desks, (_req, store) => (store.reset(), { ok: true })));

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

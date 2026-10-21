# PrizeDesk

**An AI payout desk for game studios: fund a prize pool or a creator revenue share with PayPal, let an agent check the numbers for fraud and explain every split, approve it, and pay everyone with PayPal Payouts.**

> Status: in development for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (submission deadline Nov 12, 2026). This README grows with the build.

## The problem

Studios increasingly pay people who are not on payroll: map and mod makers who earn a share of season revenue, and players who win community tournaments. Today that means a spreadsheet, manual checks and dozens of individual transfers, and it fails in predictable ways:

- **Farmed metrics.** Bots and replay farms inflate a creator's numbers to grab a bigger share.
- **Duplicate payees.** One person registers two creator accounts that pay out to the same inbox.
- **Thrown matches.** A team is handed a win and walks away with the prize.
- **Disputes.** "Why did I get less than last season?" has no written answer.
- **Unclaimed money.** Payouts sent to an address with no PayPal account sit unclaimed and bounce back after 30 days.

## What PrizeDesk does

1. **Funds the pool with PayPal.** Players buy a supporter pack through PayPal Checkout, and a sponsor is invoiced through PayPal Invoicing. Incoming money is reconciled against the pool.
2. **Checks fairness.** Deterministic detectors flag bot sessions, replay farming, report spikes, shared payout accounts and suspicious matches. The agent explains each flag in plain language.
3. **Splits by a policy you write in English.** For example: *"70% by engaged playtime, 30% by unique players, cap each creator at 25%, minimum payout $10, hold anyone flagged."* The agent turns the policy into a validated rule set. Code does the arithmetic, never the model, so the cents always add up.
4. **A human approves.** Nothing moves without one click from a person, and a hard batch ceiling is enforced in code.
5. **Pays with PayPal Payouts** and follows each item through to the end. Unclaimed payouts get a reminder and a retry on the calendar, and failed ones get a proposed fix.

## Run it

```bash
npm install
cp .env.example .env   # works as is: offline model, no PayPal calls until you add sandbox keys
npm test               # 42 tests: splits, fraud checks, policy parsing, guardrails, sponsors, webhooks, agent, API
npm run dev            # API on :8787 plus the UI on http://localhost:5183
```

Optional, with PayPal sandbox keys and a Gemini key in `.env` (`LLM_PROVIDER=gemini`):

```bash
npm run agent:live     # ask the real model to draft a payout and explain the holds
npm run e2e:sandbox    # draft -> human approval -> PayPal Payouts batch -> status tracking, on test money
```

## Guardrails

The agent prepares; people decide.

- **No tool can move money.** The agent can draft runs, explain them, check status and draft messages. Approving and submitting are separate endpoints that only a person calls.
- **An approval is bound to exactly what was approved.** It stores a fingerprint of who gets paid, at which address and how much. If anything changes afterwards, the submit is refused.
- **A run cannot pay out more than the pool received.** It is checked against the fund ledger: studio deposits, Checkout sales and paid sponsor invoices, minus earlier payouts. A sponsor invoice counts only once PayPal reports it paid.
- **A hard per-batch ceiling** (`MAX_BATCH_USD`) applies, plus PayPal idempotency keys so a retried submit cannot pay twice.

## Deploy (Render)

`render.yaml` is a Render Blueprint for a free web service:

1. In Render, go to **New → Blueprint** and connect this repository.
2. Enter the four secrets it asks for: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `GEMINI_API_KEY`, and `PAYPAL_WEBHOOK_ID` (leave this one empty at first).
3. After the first deploy, run `npm run webhook:register -- https://<your-app>.onrender.com` locally and put the printed id into `PAYPAL_WEBHOOK_ID`.

The hosted build runs in **demo mode** (`DEMO_MODE=1`):

- Every visitor gets a private, in-memory desk, so judges never see or change each other's runs.
- The agent, payouts and invoices are rate-limited per visitor.
- Demo payouts go to `@example.com` addresses, so they stay unclaimed. After an hour they are pulled back to recycle the sandbox test money.
- If the Gemini free tier is out of quota, the agent answers with the offline model and labels the reply as such.

## Webhooks

`POST /api/webhooks/paypal` accepts these events:

- `PAYMENT.PAYOUTS-ITEM.*` and `PAYMENT.PAYOUTSBATCH.*`, which refresh the matching run;
- `INVOICING.INVOICE.PAID`, which credits the sponsor's pool.

Each delivery is verified with PayPal's `verify-webhook-signature` API, and an event is processed only once.

## Built with

- PayPal REST APIs (Checkout, Invoicing, Transactions, Payouts, Webhooks) and the [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)
- An LLM with tool calling. It is pluggable: a `mock` provider runs the whole demo without any API key
- AG Grid for the payout ledger, and Bryntum Scheduler for the payout calendar
- TypeScript, React, Vite and Express

All demo data is synthetic: generated creators, players and teams. No real games or people are involved.

## License

[MIT](LICENSE)

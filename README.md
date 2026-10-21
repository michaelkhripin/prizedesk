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
npm test               # 36 tests: splits, fraud checks, policy parsing, guardrails, agent, API
npm start              # API on http://localhost:8787
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
- **A run cannot pay out more than the pool received.** It is checked against the fund ledger: deposits and Checkout sales, minus earlier payouts. Paid sponsor invoices will join the ledger next.
- **A hard per-batch ceiling** (`MAX_BATCH_USD`) applies, plus PayPal idempotency keys so a retried submit cannot pay twice.

## Built with

- PayPal REST APIs (Checkout, Invoicing, Transactions, Payouts, Webhooks) and the [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)
- An LLM with tool calling. It is pluggable: a `mock` provider runs the whole demo without any API key
- AG Grid for the payout ledger, and Bryntum Scheduler for the payout calendar
- TypeScript, React, Vite and Express

All demo data is synthetic: generated creators, players and teams. No real games or people are involved.

## License

[MIT](LICENSE)

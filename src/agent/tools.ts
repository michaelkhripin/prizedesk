import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  DEFAULT_PRIZE_POLICY,
  DEFAULT_REVENUE_POLICY,
  type PrizePolicy,
  type RevenueSharePolicy,
} from '../core/index.js';
import { describeAllocation, describeFlag, usd } from '../desk/explain.js';
import { draftRun, getRun, payable, refreshRun, sumCents, type PayoutsApi } from '../desk/runs.js';
import { invoiceSponsor, syncSponsorInvoice, type InvoicingApi } from '../desk/sponsors.js';
import { fundedCents, paidOutCents, type Run, type State, type Store } from '../desk/store.js';
import type { JsonSchema, ToolSpec } from './llm.js';

export interface ToolContext {
  store: Store;
  payouts?: PayoutsApi;
  invoicing?: InvoicingApi;
  /** PayPal Agent Toolkit tools (ai-sdk flavour), when PayPal credentials are configured. */
  paypalTools?: Record<string, { description: string; parameters: z.ZodTypeAny; execute: (args: unknown) => Promise<unknown> }>;
}

export interface AgentTool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

function schemaOf(zodSchema: z.ZodTypeAny): JsonSchema {
  const { $schema: _drop, ...rest } = zodToJsonSchema(zodSchema, { $refStrategy: 'none' }) as JsonSchema;
  return rest;
}

function tool<S extends z.ZodTypeAny>(
  name: string,
  description: string,
  params: S,
  run: (args: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown,
): AgentTool {
  return {
    spec: { name, description, parameters: schemaOf(params) },
    run: async (args, ctx) => run(params.parse(args), ctx),
  };
}

function handleOf(state: State, id: string): string {
  return (
    state.season.creators.find((c) => c.id === id)?.handle ??
    state.tournament.players.find((p) => p.id === id)?.handle ??
    state.tournament.teams.find((t) => t.id === id)?.name ??
    id
  );
}

function latestRun(state: State, kind?: Run['kind']): Run | undefined {
  return [...state.runs].reverse().find((r) => !kind || r.kind === kind);
}

function resolveRecipient(state: State, ref: string): string {
  const q = ref.trim().toLowerCase();
  const hit =
    state.season.creators.find((c) => c.id === q || c.handle.toLowerCase() === q) ??
    state.tournament.players.find((p) => p.id === q || p.handle.toLowerCase() === q);
  return hit?.id ?? ref;
}

export function runSummary(state: State, run: Run) {
  const pay = payable(run);
  const held = run.allocations.filter((a) => a.status === 'held');
  const rolled = run.allocations.filter((a) => a.status === 'below_minimum');
  const flagsFor = (id: string) => {
    const teamId = state.tournament.players.find((p) => p.id === id)?.teamId;
    return run.flags.filter((f) => f.subjectId === id || f.subjectId === teamId);
  };
  const summary =
    `Draft ${run.id}: ${usd(sumCents(pay))} to ${pay.length} recipients, ` +
    `${usd(sumCents(held))} held for ${held.length} flagged recipients` +
    (rolled.length ? `, ${usd(sumCents(rolled))} from ${rolled.length} small shares rolled over` : '') +
    (run.unassignedCents ? `, ${usd(run.unassignedCents)} left unassigned by the cap` : '') +
    '. A person has to approve it before any money moves.';
  return {
    run_id: run.id,
    kind: run.kind,
    status: run.status,
    policy: run.policy,
    defaulted_fields: run.defaulted,
    payable_total: usd(sumCents(pay)),
    payable_count: pay.length,
    held: held.map((a) => ({
      recipient_id: a.recipientId,
      handle: handleOf(state, a.recipientId),
      amount: usd(a.amountCents),
      why: flagsFor(a.recipientId).map(describeFlag),
    })),
    medium_flags: run.flags
      .filter((f) => f.severity === 'medium')
      .map((f) => ({ subject: handleOf(state, f.subjectId), why: describeFlag(f) })),
    rolled_over_total: usd(sumCents(rolled)),
    top_recipients: [...pay]
      .sort((a, b) => b.amountCents - a.amountCents)
      .slice(0, 5)
      .map((a) => ({ handle: handleOf(state, a.recipientId), amount: describeAllocation(a) })),
    summary,
  };
}

const pct = z.number().min(0).max(100);

export const deskTools: AgentTool[] = [
  tool(
    'get_desk_overview',
    'Pools (funded, paid out, available), payout runs and their status. Call this first when unsure what exists.',
    z.object({}),
    (_args, { store }) => {
      const s = store.get();
      const pools = [
        { id: s.season.id, name: s.season.name, target: s.season.poolCents },
        { id: s.tournament.id, name: s.tournament.name, target: s.tournament.poolCents },
      ].map((p) => ({
        pool_id: p.id,
        name: p.name,
        target: usd(p.target),
        funded: usd(fundedCents(s, p.id)),
        paid_out: usd(paidOutCents(s, p.id)),
        available: usd(fundedCents(s, p.id) - paidOutCents(s, p.id)),
      }));
      const runs = s.runs.map((r) => ({
        run_id: r.id,
        kind: r.kind,
        status: r.status,
        payable_total: usd(sumCents(payable(r))),
        held: r.allocations.filter((a) => a.status === 'held').length,
        approved_by: r.approval?.by,
      }));
      const sponsors = s.sponsors.map((sp) => ({ sponsor_id: sp.id, name: sp.name, pledge: usd(sp.pledgeCents), status: sp.status, invoice_id: sp.invoiceId }));
      return {
        pools,
        sponsors,
        runs,
        summary:
          `${pools.map((p) => `${p.name}: ${p.available} available of ${p.funded} funded`).join('; ')}. ` +
          `${sponsors.map((sp) => `${sp.name} pledged ${sp.pledge} (${sp.status})`).join('; ')}. ${runs.length} payout run(s).`,
      };
    },
  ),

  tool(
    'draft_payout_run',
    'Create a DRAFT payout run from a split policy. kind=revenue_share splits the season creator fund by metrics; kind=prize_pool splits the tournament pool by placement. Pass the policy as written by the user in policy_text, plus the structured fields you understood from it. Arithmetic, fraud checks and validation are done by code. Drafts never move money.',
    z.object({
      kind: z.enum(['revenue_share', 'prize_pool']),
      policy_text: z.string().describe('The policy in the user’s own words'),
      engaged_minutes_pct: pct.optional().describe('revenue_share: weight of engaged playtime, 0-100'),
      unique_players_pct: pct.optional().describe('revenue_share: weight of unique players, 0-100'),
      cap_pct: pct.optional().describe('revenue_share: max share of the pool per creator, 0-100'),
      placements_pct: z.array(pct).optional().describe('prize_pool: share per place, 1st first, must sum to 100'),
      min_payout_usd: z.number().min(0).optional(),
      hold_flagged: z.boolean().optional().describe('Hold recipients with high-severity fraud flags'),
    }),
    (a, { store }) => {
      const structured =
        a.kind === 'revenue_share'
          ? a.engaged_minutes_pct !== undefined || a.unique_players_pct !== undefined || a.cap_pct !== undefined
          : a.placements_pct !== undefined;
      let policy: RevenueSharePolicy | PrizePolicy | undefined;
      if (structured && a.kind === 'revenue_share') {
        const em = a.engaged_minutes_pct ?? 100 - (a.unique_players_pct ?? 0);
        policy = {
          weights: { engagedMinutes: em / 100, uniquePlayers: (a.unique_players_pct ?? 100 - em) / 100 },
          capBps: Math.round((a.cap_pct ?? DEFAULT_REVENUE_POLICY.capBps / 100) * 100),
          minPayoutCents: Math.round((a.min_payout_usd ?? DEFAULT_REVENUE_POLICY.minPayoutCents / 100) * 100),
          holdFlagged: a.hold_flagged ?? DEFAULT_REVENUE_POLICY.holdFlagged,
        };
      } else if (structured) {
        policy = {
          placementBps: a.placements_pct!.map((p) => Math.round(p * 100)),
          minPayoutCents: Math.round((a.min_payout_usd ?? DEFAULT_PRIZE_POLICY.minPayoutCents / 100) * 100),
          holdFlagged: a.hold_flagged ?? DEFAULT_PRIZE_POLICY.holdFlagged,
        };
      }
      const run = draftRun(store, { kind: a.kind, text: a.policy_text, policy } as never, 'agent');
      return runSummary(store.get(), run);
    },
  ),

  tool(
    'explain_recipient',
    'Everything behind one recipient’s amount in a run: their metrics against the season median, their share, and any fraud flags with evidence. Use it to answer "why did X get this" or "why is X on hold".',
    z.object({
      recipient: z.string().describe('Recipient id (cr_004, pl_51) or handle'),
      run_id: z.string().optional().describe('Defaults to the latest run'),
    }),
    (a, { store }) => {
      const s = store.get();
      const id = resolveRecipient(s, a.recipient);
      const run = a.run_id ? getRun(s, a.run_id) : latestRun(s, id.startsWith('pl_') ? 'prize_pool' : 'revenue_share');
      if (!run) return { error: 'No payout run yet. Draft one first.' };
      const alloc = run.allocations.find((x) => x.recipientId === id);
      if (!alloc) return { error: `${a.recipient} is not part of ${run.id}` };
      const teamId = s.tournament.players.find((p) => p.id === id)?.teamId;
      const flags = run.flags.filter((f) => f.subjectId === id || f.subjectId === teamId);
      const stats = s.season.stats.find((x) => x.creatorId === id);
      const med = (k: 'plays' | 'engagedMinutes' | 'uniquePlayers' | 'medianSessionSec') => {
        const xs = s.season.stats.map((x) => x[k]).sort((p, q) => p - q);
        return xs[Math.floor(xs.length / 2)];
      };
      const item = run.items[id];
      return {
        run_id: run.id,
        handle: handleOf(s, id),
        outcome: describeAllocation(alloc),
        payout_status: item?.status ?? 'not submitted',
        flags: flags.map((f) => ({ severity: f.severity, kind: f.kind, why: describeFlag(f) })),
        metrics: stats
          ? {
              engaged_minutes: stats.engagedMinutes, season_median_engaged_minutes: med('engagedMinutes'),
              unique_players: stats.uniquePlayers, season_median_unique_players: med('uniquePlayers'),
              plays: stats.plays, median_session_sec: stats.medianSessionSec,
            }
          : undefined,
        summary: `${handleOf(s, id)}: ${describeAllocation(alloc)}${flags.length ? `; flagged: ${flags.map(describeFlag).join('; ')}` : ''}.`,
      };
    },
  ),

  tool(
    'refresh_payout_status',
    'Fetch the latest PayPal Payouts status for a submitted run and report what changed (SUCCESS, UNCLAIMED, FAILED, RETURNED).',
    z.object({ run_id: z.string().optional().describe('Defaults to the latest submitted run') }),
    async (a, { store, payouts }) => {
      const s = store.get();
      const run = a.run_id ? getRun(s, a.run_id) : [...s.runs].reverse().find((r) => r.batch);
      if (!run?.batch) return { error: 'No submitted run yet. Runs are submitted by a person after approval.' };
      const changes = await refreshRun(store, run.id, payouts);
      const fresh = getRun(store.get(), run.id);
      const by = (st: string) =>
        Object.entries(fresh.items)
          .filter(([, i]) => i.status === st)
          .map(([rid]) => {
            const alloc = fresh.allocations.find((x) => x.recipientId === rid)!;
            return { recipient_id: rid, handle: handleOf(store.get(), rid), email: alloc.payoutEmail, amount: usd(alloc.amountCents) };
          });
      const counts: Record<string, number> = {};
      for (const i of Object.values(fresh.items)) counts[i.status] = (counts[i.status] ?? 0) + 1;
      const unclaimed = by('UNCLAIMED');
      const failed = [...by('FAILED'), ...by('RETURNED'), ...by('BLOCKED')];
      return {
        run_id: run.id,
        batch_status: fresh.batch!.status,
        counts,
        changed: changes.length,
        unclaimed,
        failed,
        summary:
          `Run ${run.id} (PayPal batch ${fresh.batch!.batchId}): ` +
          Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') +
          (unclaimed.length ? `. ${unclaimed.length} unclaimed: these addresses have no PayPal account yet; the money returns after 30 days unless claimed.` : '.'),
      };
    },
  ),

  tool(
    'draft_recipient_message',
    'Facts and a starting draft for a message to one recipient (unclaimed payout reminder, hold notice, or share explanation). The message is a draft for a person to send; it is never sent automatically.',
    z.object({
      recipient: z.string(),
      purpose: z.enum(['unclaimed_reminder', 'hold_notice', 'share_explanation']),
      run_id: z.string().optional(),
    }),
    (a, { store }) => {
      const s = store.get();
      const id = resolveRecipient(s, a.recipient);
      const run = a.run_id ? getRun(s, a.run_id) : latestRun(s, id.startsWith('pl_') ? 'prize_pool' : 'revenue_share');
      const alloc = run?.allocations.find((x) => x.recipientId === id);
      if (!run || !alloc) return { error: `${a.recipient} has no allocation in a payout run` };
      const name = handleOf(s, id);
      const program = run.kind === 'revenue_share' ? s.season.name : s.tournament.name;
      const draft = {
        unclaimed_reminder: `Hi ${name}, your ${program} payout of ${usd(alloc.amountCents)} was sent through PayPal to ${alloc.payoutEmail}, but there is no PayPal account on that address yet. Sign up or add this email to your PayPal account to claim it; unclaimed payouts are returned after 30 days. If the address is wrong, reply with the right one and we will re-send.`,
        hold_notice: `Hi ${name}, your ${program} share of ${usd(alloc.amountCents)} is reserved for you but on hold while we review some unusual activity. We will be in touch within 5 working days; you do not need to do anything right now.`,
        share_explanation: `Hi ${name}, your ${program} payout is ${describeAllocation(alloc)}. It follows the published split policy: ${run.policyText}`,
      }[a.purpose];
      return { recipient_id: id, handle: name, email: alloc.payoutEmail, draft, summary: draft };
    },
  ),
];

function needInvoicing(ctx: ToolContext): InvoicingApi {
  if (!ctx.invoicing) throw new Error('PayPal is not configured, so invoices are unavailable');
  return ctx.invoicing;
}

deskTools.push(
  tool(
    'invoice_sponsor',
    'Create and send a PayPal invoice for a sponsor’s pledged contribution to a prize pool. The pool is credited only after PayPal reports the invoice paid.',
    z.object({ sponsor_id: z.string().describe('For example sp_northwind; see get_desk_overview') }),
    async (a, ctx) => {
      const sp = await invoiceSponsor(ctx.store, needInvoicing(ctx), a.sponsor_id, 'agent');
      return { sponsor: sp.name, invoice_id: sp.invoiceId, payer_link: sp.invoiceUrl, amount: usd(sp.pledgeCents), summary: `Sent PayPal invoice ${sp.invoiceId} for ${usd(sp.pledgeCents)} to ${sp.name} (${sp.email}). The pool is credited when it is paid.` };
    },
  ),
  tool(
    'check_sponsor_invoices',
    'Check every sent sponsor invoice with PayPal and credit the prize pool for any that are now paid.',
    z.object({}),
    async (_a, ctx) => {
      const api = needInvoicing(ctx);
      const results = [];
      for (const sp of ctx.store.get().sponsors.filter((x) => x.invoiceId)) {
        const r = await syncSponsorInvoice(ctx.store, api, sp.id, 'agent');
        results.push({ sponsor: sp.name, invoice_id: sp.invoiceId, paypal_status: r.invoiceStatus, credited_now: r.credited });
      }
      return {
        invoices: results,
        summary: results.length
          ? results.map((r) => `${r.sponsor}: invoice ${r.paypal_status}${r.credited_now ? ', pool credited now' : ''}`).join('; ')
          : 'No sponsor invoices have been sent yet.',
      };
    },
  ),
);

/** Wraps PayPal Agent Toolkit tools so the agent can call them like any other tool. */
export function paypalToolkitTools(ctx: ToolContext): AgentTool[] {
  return Object.entries(ctx.paypalTools ?? {}).map(([name, t]) => ({
    spec: { name, description: t.description, parameters: schemaOf(t.parameters) },
    run: async (args) => t.execute(t.parameters.parse(args)),
  }));
}

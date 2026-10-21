import { usd } from './explain.js';
import type { Sponsor, State, Store } from './store.js';
import { GuardrailError } from './runs.js';

export interface InvoiceState {
  status: string;
  amountCents: number;
}

/** The slice of PayPal Invoicing PrizeDesk uses; backed by the PayPal Agent Toolkit. */
export interface InvoicingApi {
  createAndSend(s: Sponsor, poolName: string): Promise<{ invoiceId: string; invoiceUrl: string }>;
  get(invoiceId: string): Promise<InvoiceState>;
  recordPayment(invoiceId: string, amountCents: number, method: string): Promise<void>;
}

type ToolkitTool = { parameters: { parse: (x: unknown) => unknown }; execute: (args: unknown) => Promise<unknown> };

const json = (x: unknown) => (typeof x === 'string' ? JSON.parse(x) : x) as Record<string, any>;

export function toolkitInvoicing(tools: Record<string, ToolkitTool>): InvoicingApi {
  const call = async (name: string, args: unknown) => {
    const t = tools[name];
    if (!t) throw new GuardrailError(`PayPal tool ${name} is not enabled`);
    return json(await t.execute(t.parameters.parse(args)));
  };
  return {
    async createAndSend(s, poolName) {
      const created = await call('create_invoice', {
        currency_code: 'USD',
        note: `${poolName} co-sponsorship: your contribution to the prize pool. Thank you for supporting the community!`,
        primary_recipients: [{ billing_info: { business_name: s.name, email_address: s.email } }],
        items: [{ name: `${poolName} prize pool co-sponsorship`, quantity: '1', unit_amount: { currency_code: 'USD', value: (s.pledgeCents / 100).toFixed(2) } }],
      });
      const invoiceId = String(created.href).split('/').pop()!;
      const sent = await call('send_invoice', { invoice_id: invoiceId, send_to_recipient: true });
      return { invoiceId, invoiceUrl: String(sent.href ?? '') };
    },
    async get(invoiceId) {
      const inv = await call('get_invoice', { invoice_id: invoiceId });
      return { status: String(inv.status), amountCents: Math.round(Number(inv.amount?.value ?? 0) * 100) };
    },
    async recordPayment(invoiceId, amountCents, method) {
      await call('record_payment_for_invoice', {
        invoice_id: invoiceId,
        method,
        payment_date: new Date().toISOString().slice(0, 10),
        amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
        note: 'Recorded in PrizeDesk by the studio',
      });
    },
  };
}

function sponsorOf(state: State, idOrInvoice: string): Sponsor {
  const s = state.sponsors.find((x) => x.id === idOrInvoice || x.invoiceId === idOrInvoice);
  if (!s) throw new GuardrailError(`unknown sponsor ${idOrInvoice}`);
  return s;
}

const poolName = (state: State, poolId: string) =>
  poolId === state.tournament.id ? state.tournament.name : state.season.name;

export async function invoiceSponsor(store: Store, api: InvoicingApi, sponsorId: string, actor: string): Promise<Sponsor> {
  const s = sponsorOf(store.get(), sponsorId);
  if (s.status !== 'pledged') throw new GuardrailError(`${s.name} was already invoiced (${s.invoiceId})`);
  const { invoiceId, invoiceUrl } = await api.createAndSend(s, poolName(store.get(), s.poolId));
  return store.update((st) => {
    const sp = sponsorOf(st, sponsorId);
    Object.assign(sp, { status: 'invoiced', invoiceId, invoiceUrl });
    st.audit.push({ at: new Date().toISOString(), actor, action: 'invoice.sent', detail: { sponsor: sp.name, invoiceId, amountCents: sp.pledgeCents } });
    return sp;
  });
}

const PAID = new Set(['PAID', 'MARKED_AS_PAID']);

/**
 * Checks a sponsor's invoice and, once PayPal reports it paid, credits the
 * prize pool exactly once. Called by the agent, the UI and the INVOICING.INVOICE.PAID webhook.
 */
export async function syncSponsorInvoice(store: Store, api: InvoicingApi, idOrInvoice: string, actor: string) {
  const s = sponsorOf(store.get(), idOrInvoice);
  if (!s.invoiceId) return { sponsor: s, invoiceStatus: 'NOT_INVOICED', credited: false };
  const inv = await api.get(s.invoiceId);
  const credited = store.update((st) => {
    const sp = sponsorOf(st, s.id);
    if (!PAID.has(inv.status) || sp.status === 'paid') return false;
    sp.status = 'paid';
    const at = new Date().toISOString();
    st.fund.push({ id: `fund_${st.fund.length + 1}`, at, poolId: sp.poolId, source: 'sponsor_invoice', amountCents: inv.amountCents, ref: sp.invoiceId!, note: `${sp.name} paid invoice ${sp.invoiceId} (${usd(inv.amountCents)})` });
    st.audit.push({ at, actor, action: 'invoice.paid', detail: { sponsor: sp.name, invoiceId: sp.invoiceId, amountCents: inv.amountCents } });
    return true;
  });
  return { sponsor: sponsorOf(store.get(), s.id), invoiceStatus: inv.status, credited };
}

/** A person records an off-PayPal payment (for example a wire transfer). The agent cannot call this. */
export async function recordSponsorPayment(store: Store, api: InvoicingApi, sponsorId: string, by: string) {
  if (!by.trim()) throw new GuardrailError('recording a payment needs your name');
  const s = sponsorOf(store.get(), sponsorId);
  if (s.status !== 'invoiced' || !s.invoiceId) throw new GuardrailError(`${s.name} has no open invoice`);
  await api.recordPayment(s.invoiceId, s.pledgeCents, 'BANK_TRANSFER');
  store.audit(`human:${by}`, 'invoice.payment_recorded', { sponsor: s.name, invoiceId: s.invoiceId });
  return syncSponsorInvoice(store, api, sponsorId, `human:${by}`);
}

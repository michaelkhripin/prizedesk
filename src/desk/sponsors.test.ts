import { describe, expect, it } from 'vitest';
import { fundedCents, Store } from './store.js';
import { invoiceSponsor, recordSponsorPayment, syncSponsorInvoice, type InvoicingApi } from './sponsors.js';

function fakeInvoicing() {
  const invoices = new Map<string, { status: string; amountCents: number }>();
  const api: InvoicingApi = {
    async createAndSend(s) {
      invoices.set('INV-1', { status: 'SENT', amountCents: s.pledgeCents });
      return { invoiceId: 'INV-1', invoiceUrl: 'https://paypal.test/INV-1' };
    },
    async get(id) {
      return invoices.get(id)!;
    },
    async recordPayment(id) {
      invoices.get(id)!.status = 'MARKED_AS_PAID';
    },
  };
  return { api, invoices };
}

describe('sponsor invoices', () => {
  it('credits the pool only once PayPal says the invoice is paid, and only once', async () => {
    const store = new Store(null);
    const cup = store.get().tournament.id;
    const before = fundedCents(store.get(), cup);
    const { api, invoices } = fakeInvoicing();

    await invoiceSponsor(store, api, 'sp_northwind', 'agent');
    expect((await syncSponsorInvoice(store, api, 'sp_northwind', 'agent')).credited).toBe(false);
    expect(fundedCents(store.get(), cup)).toBe(before);

    invoices.get('INV-1')!.status = 'PAID';
    expect((await syncSponsorInvoice(store, api, 'INV-1', 'paypal')).credited).toBe(true);
    expect((await syncSponsorInvoice(store, api, 'INV-1', 'paypal')).credited).toBe(false);
    expect(fundedCents(store.get(), cup)).toBe(before + 5_000_00);
  });

  it('refuses to invoice twice and needs a name to record a payment', async () => {
    const store = new Store(null);
    const { api } = fakeInvoicing();
    await invoiceSponsor(store, api, 'sp_northwind', 'agent');
    await expect(invoiceSponsor(store, api, 'sp_northwind', 'agent')).rejects.toThrow(/already invoiced/);
    await expect(recordSponsorPayment(store, api, 'sp_northwind', ' ')).rejects.toThrow(/name/);
    expect((await recordSponsorPayment(store, api, 'sp_northwind', 'Michael')).credited).toBe(true);
  });
});

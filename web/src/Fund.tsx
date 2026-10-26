import { PayPalButtons, PayPalScriptProvider } from '@paypal/react-paypal-js';
import { useState } from 'react';
import { api, usd, type DeskState, type PublicConfig } from './api';

const PACKS = [
  { id: 'supporter', name: 'Season 7 Supporter Pack', price: '$9.99', blurb: 'Cosmetic badge and banner. Half of the price goes to the creator fund.' },
  { id: 'champion', name: 'Season 7 Champion Pack', price: '$24.99', blurb: 'Badge, banner and an exclusive emote. Half goes to the creator fund.' },
];

const SOURCE_LABEL: Record<string, string> = {
  studio_deposit: 'Studio deposit',
  checkout: 'PayPal Checkout',
  sponsor_invoice: 'Sponsor invoice',
};

function approverName(): string {
  try {
    return localStorage.getItem('prizedesk.approver') ?? '';
  } catch {
    return '';
  }
}

function Sponsors({ state, onChanged }: { state: DeskState; onChanged: () => Promise<void> }) {
  const [msg, setMsg] = useState<string>();
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setMsg(undefined);
    try {
      const res = (await fn()) as { invoiceStatus?: string; credited?: boolean };
      setMsg(done ?? (res?.invoiceStatus ? `PayPal invoice status: ${res.invoiceStatus}${res.credited ? '. Pool credited.' : ''}` : undefined));
      await onChanged();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <table>
      <thead>
        <tr><th>Sponsor</th><th>Pool</th><th>Status</th><th className="num">Pledge</th><th /></tr>
      </thead>
      <tbody>
        {state.sponsors.map((sp) => (
          <tr key={sp.id}>
            <td>{sp.name}<div className="mono" style={{ color: 'var(--muted)' }}>{sp.email}</div></td>
            <td>{state.pools.find((p) => p.id === sp.poolId)?.name}</td>
            <td>
              <span className={`badge ${sp.status === 'paid' ? 'ok' : sp.status === 'invoiced' ? 'warn' : ''}`}>{sp.status}</span>
              {sp.invoiceUrl && <div><a href={sp.invoiceUrl} target="_blank" rel="noreferrer" className="mono">{sp.invoiceId}</a></div>}
            </td>
            <td className="num">{usd(sp.pledgeCents)}</td>
            <td className="row-actions">
              {sp.status === 'pledged' && <button onClick={() => act(() => api.invoiceSponsor(sp.id, approverName() || 'studio'), 'Invoice sent with PayPal.')}>Send PayPal invoice</button>}
              {sp.status === 'invoiced' && (
                <>
                  <button onClick={() => act(() => api.checkSponsor(sp.id))}>Check payment</button>
                  <button
                    title="The sponsor paid outside PayPal, for example by wire"
                    onClick={() => {
                      const by = approverName() || prompt('Your name, for the audit log') || '';
                      if (by) act(() => api.recordSponsorPayment(sp.id, by), 'Payment recorded on the PayPal invoice. Pool credited.');
                    }}
                  >
                    Record wire payment
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      {msg && (
        <tfoot>
          <tr><td colSpan={5}><span className="badge">{msg}</span></td></tr>
        </tfoot>
      )}
    </table>
  );
}

export function Fund({ state, config, onChanged }: { state: DeskState; config?: PublicConfig; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState<string>();
  const poolName = (id: string) => state.pools.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="fund fill">
      <div className="panel scroll">
        {config?.paypalConfigured && <Sponsors state={state} onChanged={onChanged} />}
        <table>
          <thead>
            <tr><th>When</th><th>Pool</th><th>Source</th><th>Note</th><th className="num">Amount</th></tr>
          </thead>
          <tbody>
            {[...state.fund].reverse().map((f) => (
              <tr key={f.id}>
                <td className="mono">{new Date(f.at).toLocaleString()}</td>
                <td>{poolName(f.poolId)}</td>
                <td><span className={`badge ${f.source === 'checkout' ? 'brand' : ''}`}>{SOURCE_LABEL[f.source]}</span></td>
                <td>{f.note}</td>
                <td className="num">{usd(f.amountCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="panel scroll">
        {!config?.paypalConfigured ? (
          <div className="empty">Add PayPal sandbox keys to <code>.env</code> to sell supporter packs with PayPal Checkout.</div>
        ) : (
          <PayPalScriptProvider options={{ clientId: config.paypalClientId, currency: 'USD', intent: 'capture' }}>
            {PACKS.map((p) => (
              <div className="pack" key={p.id}>
                <h3>{p.name} · {p.price}</h3>
                <p>{p.blurb}</p>
                <PayPalButtons
                  style={{ layout: 'vertical', height: 38 }}
                  createOrder={async () => (await api.createOrder(p.id)).orderId}
                  onApprove={async (data) => {
                    const res = await api.captureOrder(data.orderID);
                    setNote(res.toFundCents ? `Thanks! ${usd(res.toFundCents)} went to the Season 7 creator fund.` : `Order ${res.status}`);
                    await onChanged();
                  }}
                  onError={(e) => setNote(`PayPal error: ${String(e)}`)}
                />
              </div>
            ))}
            {note && <div className="pack"><span className="badge ok">{note}</span></div>}
            <div className="pack"><p style={{ fontSize: 12 }}>Sandbox: pay with a PayPal sandbox personal account or a test card. No real money moves.</p></div>
          </PayPalScriptProvider>
        )}
      </div>
    </div>
  );
}

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

export function Fund({ state, config, onChanged }: { state: DeskState; config?: PublicConfig; onChanged: () => Promise<void> }) {
  const [note, setNote] = useState<string>();
  const poolName = (id: string) => state.pools.find((p) => p.id === id)?.name ?? id;

  return (
    <div className="fund fill">
      <div className="panel scroll">
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
                  style={{ layout: 'horizontal', height: 38, tagline: false }}
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

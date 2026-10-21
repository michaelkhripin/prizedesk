import { paypal } from './client.js';

/** Creates a Checkout order for a supporter pack; the browser approves it with the JS SDK. */
export async function createOrder(amountCents: number, description: string, referenceId: string) {
  const res = await paypal<{ id: string; status: string }>('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: referenceId,
        description,
        amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
      },
    ],
  });
  return { orderId: res.id, status: res.status };
}

export async function captureOrder(orderId: string) {
  const res = await paypal<{
    id: string;
    status: string;
    purchase_units: { reference_id?: string; payments?: { captures?: { id: string; amount: { value: string } }[] } }[];
  }>('POST', `/v2/checkout/orders/${orderId}/capture`, {}, `capture-${orderId}`);
  const unit = res.purchase_units[0];
  const capture = unit?.payments?.captures?.[0];
  return {
    orderId: res.id,
    status: res.status,
    referenceId: unit?.reference_id,
    captureId: capture?.id,
    amountCents: Math.round(Number(capture?.amount.value ?? 0) * 100),
  };
}

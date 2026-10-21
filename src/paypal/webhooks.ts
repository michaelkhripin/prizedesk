import { paypal } from './client.js';

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource: Record<string, any>;
}

const HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;

/** Asks PayPal whether a webhook delivery is genuine. Nothing is trusted without it. */
export async function verifyWebhook(
  headers: Record<string, string | string[] | undefined>,
  event: WebhookEvent,
  webhookId: string,
): Promise<boolean> {
  const h = (k: (typeof HEADERS)[number]) => String(headers[k] ?? '');
  if (HEADERS.some((k) => !h(k))) return false;
  const res = await paypal<{ verification_status: string }>('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: h('paypal-auth-algo'),
    cert_url: h('paypal-cert-url'),
    transmission_id: h('paypal-transmission-id'),
    transmission_sig: h('paypal-transmission-sig'),
    transmission_time: h('paypal-transmission-time'),
    webhook_id: webhookId,
    webhook_event: event,
  });
  return res.verification_status === 'SUCCESS';
}

/** Event types PrizeDesk subscribes to (scripts/register-webhook.ts). */
export const WEBHOOK_EVENTS = [
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'PAYMENT.PAYOUTS-ITEM.BLOCKED',
  'PAYMENT.PAYOUTS-ITEM.CANCELED',
  'INVOICING.INVOICE.PAID',
];

/** Which payout batch or invoice an event is about. */
export function eventTarget(e: WebhookEvent): { batchId?: string; invoiceId?: string } {
  if (e.event_type.startsWith('PAYMENT.PAYOUTS')) {
    return { batchId: e.resource.payout_batch_id ?? e.resource.batch_header?.payout_batch_id };
  }
  if (e.event_type.startsWith('INVOICING.INVOICE')) return { invoiceId: e.resource.invoice?.id ?? e.resource.id };
  return {};
}

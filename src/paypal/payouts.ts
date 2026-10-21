import { paypal } from './client.js';

export interface PayoutItemInput {
  senderItemId: string;
  receiver: string;
  amountCents: number;
  note: string;
}

export type ItemStatus =
  | 'SUCCESS' | 'FAILED' | 'PENDING' | 'UNCLAIMED' | 'RETURNED' | 'ONHOLD' | 'BLOCKED' | 'REFUNDED' | 'REVERSED';

export interface PayoutItemState {
  payoutItemId: string;
  senderItemId: string;
  status: ItemStatus;
  errorName?: string;
  feeCents: number;
}

export interface BatchState {
  batchId: string;
  status: string;
  items: PayoutItemState[];
}

const toUsd = (cents: number) => (cents / 100).toFixed(2);
const toCents = (v?: string) => Math.round(Number(v ?? 0) * 100);

export async function createPayoutBatch(
  senderBatchId: string,
  subject: string,
  items: PayoutItemInput[],
): Promise<{ batchId: string; status: string }> {
  const res = await paypal<{ batch_header: { payout_batch_id: string; batch_status: string } }>(
    'POST',
    '/v1/payments/payouts',
    {
      sender_batch_header: { sender_batch_id: senderBatchId, email_subject: subject, recipient_type: 'EMAIL' },
      items: items.map((i) => ({
        recipient_type: 'EMAIL',
        receiver: i.receiver,
        amount: { value: toUsd(i.amountCents), currency: 'USD' },
        note: i.note,
        sender_item_id: i.senderItemId,
      })),
    },
    // Same run, same key: a retried submit can never pay twice.
    `prizedesk-${senderBatchId}`,
  );
  return { batchId: res.batch_header.payout_batch_id, status: res.batch_header.batch_status };
}

interface RawItem {
  payout_item_id: string;
  transaction_status: ItemStatus;
  payout_item_fee?: { value: string };
  payout_item: { sender_item_id: string };
  errors?: { name: string };
}

export async function getPayoutBatch(batchId: string): Promise<BatchState> {
  const res = await paypal<{ batch_header: { batch_status: string }; items?: RawItem[] }>(
    'GET',
    `/v1/payments/payouts/${batchId}?page_size=1000`,
  );
  return {
    batchId,
    status: res.batch_header.batch_status,
    items: (res.items ?? []).map((i) => ({
      payoutItemId: i.payout_item_id,
      senderItemId: i.payout_item.sender_item_id,
      status: i.transaction_status,
      errorName: i.errors?.name,
      feeCents: toCents(i.payout_item_fee?.value),
    })),
  };
}

/** Pulls back an unclaimed payout so the money can be re-sent to a corrected address. */
export async function cancelUnclaimedItem(payoutItemId: string): Promise<ItemStatus> {
  const res = await paypal<{ transaction_status: ItemStatus }>(
    'POST',
    `/v1/payments/payouts-item/${payoutItemId}/cancel`,
  );
  return res.transaction_status;
}

import type { Allocation, Flag, Season, Tournament } from '../../src/core/types';
import type { AuditEntry, FundEntry, Run, Sponsor } from '../../src/desk/store';

export type RunView = Run & {
  view: {
    summary: string;
    payable_total: string;
    held: { recipient_id: string; handle: string; amount: string; why: string[] }[];
  };
};

export interface Pool {
  id: string;
  name: string;
  targetCents: number;
  fundedCents: number;
  paidOutCents: number;
}

export interface DeskState {
  pools: Pool[];
  season: Season;
  tournament: Tournament;
  fund: FundEntry[];
  sponsors: Sponsor[];
  runs: RunView[];
  audit: AuditEntry[];
}

export interface PublicConfig {
  paypalClientId: string;
  paypalConfigured: boolean;
  llm: string;
  demo?: boolean;
  maxBatchUsd: number;
}

export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export type { Allocation, Flag, Run, Sponsor };

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  config: () => call<PublicConfig>('GET', '/api/config'),
  state: () => call<DeskState>('GET', '/api/state'),
  agent: (message: string, sessionId?: string) =>
    call<{ sessionId: string; reply: string; actions: AgentAction[]; model: string }>('POST', '/api/agent', { message, sessionId }),
  approve: (runId: string, approver: string) => call<Run>('POST', `/api/runs/${runId}/approve`, { approver }),
  submit: (runId: string) => call<Run>('POST', `/api/runs/${runId}/submit`),
  refresh: (runId: string) => call<{ changes: unknown[] }>('POST', `/api/runs/${runId}/refresh`),
  createOrder: (pack: string) => call<{ orderId: string }>('POST', '/api/checkout/orders', { pack }),
  captureOrder: (orderId: string) => call<{ status: string; toFundCents?: number }>('POST', `/api/checkout/orders/${orderId}/capture`),
  invoiceSponsor: (id: string, by: string) => call('POST', `/api/sponsors/${id}/invoice`, { by }),
  checkSponsor: (id: string) => call<{ invoiceStatus: string; credited: boolean }>('POST', `/api/sponsors/${id}/check`),
  recordSponsorPayment: (id: string, by: string) => call('POST', `/api/sponsors/${id}/record-payment`, { by }),
  reset: () => call('POST', '/api/reset'),
};

export const usd = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

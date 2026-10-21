import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly name: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let cached: { token: string; expiresAt: number } | undefined;

export async function accessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const { clientId, clientSecret, baseUrl } = config.paypal;
  const res = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new PayPalError(res.status, 'AUTH_FAILED', body.error_description ?? 'PayPal authentication failed');
  }
  cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 0) * 1000 };
  return cached.token;
}

/** JSON call to the PayPal REST API. `idempotencyKey` maps to PayPal-Request-Id. */
export async function paypal<T>(
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<T> {
  const res = await fetch(`${config.paypal.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': idempotencyKey ?? randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new PayPalError(res.status, json.name ?? 'PAYPAL_ERROR', json.message ?? res.statusText, json.details);
  }
  return json as T;
}

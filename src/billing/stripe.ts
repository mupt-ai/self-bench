import type { StripeConfig } from "./config.js";

export interface StripeRequestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly idempotencyKey?: string;
}

async function stripeRequest<T>(
  config: StripeConfig,
  path: string,
  init: RequestInit,
  options: StripeRequestOptions = {},
): Promise<T> {
  const response = await (options.fetchImpl ?? fetch)(`https://api.stripe.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${config.secretKey}`,
      "stripe-version": config.apiVersion,
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Stripe ${path} failed (${response.status}): ${text.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}

function formBody(values: Record<string, string>): URLSearchParams {
  return new URLSearchParams(values);
}

export async function createStripeCustomer(
  config: StripeConfig,
  input: { orgId: number; orgLogin: string },
  options?: StripeRequestOptions,
): Promise<{ id: string }> {
  return stripeRequest(
    config,
    "/v1/customers",
    {
      method: "POST",
      body: formBody({
        name: input.orgLogin,
        "metadata[selfbench_org_id]": String(input.orgId),
        "metadata[selfbench_org_login]": input.orgLogin,
      }),
    },
    options,
  );
}

export async function createCheckoutSession(
  config: StripeConfig,
  input: { customerId: string; orgId: number; successUrl: string; cancelUrl: string },
  options?: StripeRequestOptions,
): Promise<{ url: string }> {
  return stripeRequest(
    config,
    "/v1/checkout/sessions",
    {
      method: "POST",
      body: formBody({
        mode: "subscription",
        customer: input.customerId,
        "line_items[0][price]": config.priceId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        client_reference_id: String(input.orgId),
        "subscription_data[metadata][selfbench_org_id]": String(input.orgId),
      }),
    },
    options,
  );
}

export async function createPortalSession(
  config: StripeConfig,
  input: { customerId: string; returnUrl: string },
  options?: StripeRequestOptions,
): Promise<{ url: string }> {
  return stripeRequest(
    config,
    "/v1/billing_portal/sessions",
    {
      method: "POST",
      body: formBody({ customer: input.customerId, return_url: input.returnUrl }),
    },
    options,
  );
}

/** Stripe Billing Meter Events v2. The identifier and HTTP key make retries idempotent. */
export async function sendMeterEvent(
  config: StripeConfig,
  event: {
    eventName: string;
    customerId: string;
    value: number;
    identifier: string;
    timestamp: Date;
  },
  options?: StripeRequestOptions,
): Promise<{ identifier?: string }> {
  return stripeRequest(
    config,
    "/v2/billing/meter_events",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_name: event.eventName,
        identifier: event.identifier,
        // Persisted outbox time keeps the body identical across idempotent HTTP retries.
        timestamp: event.timestamp.toISOString(),
        payload: { stripe_customer_id: event.customerId, value: String(event.value) },
      }),
    },
    { ...options, idempotencyKey: event.identifier },
  );
}

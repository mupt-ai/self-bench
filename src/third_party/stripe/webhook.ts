import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingStore, SubscriptionState } from "../../db/billing.js";

const SIGNATURE_TOLERANCE_SECONDS = 300;

export function verifyStripeWebhook(
  body: Buffer,
  signature: string | undefined,
  secret: string,
  now = Date.now(),
): void {
  if (!signature) throw new Error("Missing Stripe-Signature header");
  const parts = signature.split(",").map((part) => part.split("=", 2));
  const timestampText = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").flatMap((part) => part[1] ?? []);
  const timestamp = Number(timestampText);
  if (!Number.isInteger(timestamp)) throw new Error("Invalid Stripe webhook timestamp");
  if (Math.abs(now / 1000 - timestamp) > SIGNATURE_TOLERANCE_SECONDS)
    throw new Error("Stale Stripe webhook");
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  const valid = signatures.some((candidate) => {
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  });
  if (!valid) throw new Error("Invalid Stripe webhook signature");
}

type StripeEvent = {
  id?: unknown;
  type?: unknown;
  data?: { object?: unknown };
};

type StripeSubscription = {
  id?: unknown;
  customer?: unknown;
  status?: unknown;
  cancel_at_period_end?: unknown;
  current_period_end?: unknown;
};

function subscriptionState(value: unknown): SubscriptionState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as StripeSubscription;
  if (
    typeof item.id !== "string" ||
    typeof item.customer !== "string" ||
    typeof item.status !== "string"
  )
    return undefined;
  const period = typeof item.current_period_end === "number" ? item.current_period_end : undefined;
  return {
    customerId: item.customer,
    subscriptionId: item.id,
    status: item.status,
    cancelAtPeriodEnd: item.cancel_at_period_end === true,
    ...(period ? { currentPeriodEnd: new Date(period * 1000) } : {}),
  };
}

/** Handles only subscription lifecycle events; unknown signed events are durably acknowledged. */
export async function applyStripeWebhook(store: BillingStore, body: Buffer): Promise<void> {
  const event = JSON.parse(body.toString("utf8")) as StripeEvent;
  if (typeof event.id !== "string" || typeof event.type !== "string")
    throw new Error("Invalid Stripe event");
  const state = event.type.startsWith("customer.subscription.")
    ? subscriptionState(event.data?.object)
    : undefined;
  if (event.type.startsWith("customer.subscription.") && !state)
    throw new Error("Invalid Stripe subscription event");
  await store.applyWebhook({ id: event.id, type: event.type }, state);
}

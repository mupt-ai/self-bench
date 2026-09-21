import { z } from "zod";

const emptyStringAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim() === "" ? undefined : value;

/** Frozen policy id stored on every rate snapshot. Bump only when unit semantics change. */
const BILLING_POLICY_VERSION = "v1";
/** Default: 1 unit = $1e-7 so E2B's $0.0000045/GiB-s is an exact integer. */
export const DEFAULT_BILLING_UNIT_SCALE = 10_000_000;
const DEFAULT_METER_EVENT_NAME = "selfbench_managed_usage";
/** Stripe API version that includes Billing Meter Events v2. */
const STRIPE_API_VERSION = "2025-03-31.basil";

const policySchema = z.object({
  SELFBENCH_BILLING_UNIT_SCALE: z.preprocess(
    emptyStringAsUndefined,
    z.coerce.number().int().min(1).max(1_000_000_000).default(DEFAULT_BILLING_UNIT_SCALE),
  ),
  SELFBENCH_BILLING_MARKUP_BPS: z.preprocess(
    emptyStringAsUndefined,
    z.coerce.number().int().min(0).max(100_000).default(0),
  ),
  SELFBENCH_STRIPE_METER_EVENT_NAME: z.preprocess(
    emptyStringAsUndefined,
    z.string().trim().min(1).max(100).default(DEFAULT_METER_EVENT_NAME),
  ),
});

export interface BillingPolicy {
  readonly version: typeof BILLING_POLICY_VERSION;
  readonly unitScale: number;
  /** Integer basis points added to published rates. 0 is pass-through; 1000 is 10%. */
  readonly markupBps: number;
  readonly meterEventName: string;
}

export function loadBillingPolicy(environment: NodeJS.ProcessEnv = process.env): BillingPolicy {
  const value = policySchema.parse(environment);
  return {
    version: BILLING_POLICY_VERSION,
    unitScale: value.SELFBENCH_BILLING_UNIT_SCALE,
    markupBps: value.SELFBENCH_BILLING_MARKUP_BPS,
    meterEventName: value.SELFBENCH_STRIPE_METER_EVENT_NAME,
  };
}

const stripeSchema = z.object({
  SELFBENCH_STRIPE_SECRET_KEY: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
  SELFBENCH_STRIPE_WEBHOOK_SECRET: z.preprocess(
    emptyStringAsUndefined,
    z.string().min(1).optional(),
  ),
  SELFBENCH_STRIPE_PRICE_ID: z.preprocess(emptyStringAsUndefined, z.string().min(1).optional()),
});

export interface StripeConfig {
  readonly secretKey: string;
  readonly webhookSecret: string;
  readonly priceId: string;
  readonly apiVersion: typeof STRIPE_API_VERSION;
}

/**
 * Stripe billing is all-or-nothing. Missing every variable leaves billing disabled (managed
 * runs stay available). Setting only some of them is a configuration error.
 */
export function loadStripeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): StripeConfig | undefined {
  const value = stripeSchema.parse(environment);
  const secretKey = value.SELFBENCH_STRIPE_SECRET_KEY;
  const webhookSecret = value.SELFBENCH_STRIPE_WEBHOOK_SECRET;
  const priceId = value.SELFBENCH_STRIPE_PRICE_ID;
  const set = [secretKey, webhookSecret, priceId].filter(Boolean);
  if (set.length === 0) return undefined;
  if (!secretKey || !webhookSecret || !priceId) {
    throw new Error(
      "Stripe billing requires SELFBENCH_STRIPE_SECRET_KEY, SELFBENCH_STRIPE_WEBHOOK_SECRET, and SELFBENCH_STRIPE_PRICE_ID together",
    );
  }
  return { secretKey, webhookSecret, priceId, apiVersion: STRIPE_API_VERSION };
}

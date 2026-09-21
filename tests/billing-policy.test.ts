import { expect, test } from "bun:test";
import {
  DEFAULT_BILLING_UNIT_SCALE,
  loadBillingPolicy,
  loadStripeConfig,
} from "../src/billing/config.js";
import {
  BILLING_REQUIRED_CODE,
  eligibilityFrom,
  managedBillingRefusal,
} from "../src/billing/eligibility.js";
import {
  modelBillableUnits,
  rateSnapshotSpec,
  sandboxBillableUnits,
  usdToUnits,
} from "../src/billing/policy.js";

test("Stripe config is all-or-nothing and policy defaults are pass-through", () => {
  expect(loadStripeConfig({})).toBeUndefined();
  expect(() => loadStripeConfig({ SELFBENCH_STRIPE_SECRET_KEY: "sk_test" })).toThrow(
    /requires SELFBENCH_STRIPE_SECRET_KEY/,
  );
  const fileStripe = loadStripeConfig({
    SELFBENCH_STRIPE_SECRET_KEY: "sk_test",
    SELFBENCH_STRIPE_WEBHOOK_SECRET_FILE: "/run/stripe/webhook-secret",
    SELFBENCH_STRIPE_PRICE_ID: "price_1",
  });
  expect(fileStripe?.webhookSecretFile).toBe("/run/stripe/webhook-secret");
  const stripe = loadStripeConfig({
    SELFBENCH_STRIPE_SECRET_KEY: "sk_test",
    SELFBENCH_STRIPE_WEBHOOK_SECRET: "whsec",
    SELFBENCH_STRIPE_PRICE_ID: "price_1",
  });
  expect(stripe?.priceId).toBe("price_1");
  const policy = loadBillingPolicy({});
  expect(policy).toEqual({
    version: "v1",
    unitScale: DEFAULT_BILLING_UNIT_SCALE,
    markupBps: 0,
    meterEventName: "selfbench_managed_usage",
  });
});

test("integer units come from quantities and frozen rates, not USD estimates", () => {
  const snapshot = rateSnapshotSpec(loadBillingPolicy({}));
  expect(snapshot.unitScale).toBe(DEFAULT_BILLING_UNIT_SCALE);
  expect(snapshot.markupBps).toBe(0);
  expect(usdToUnits(1, snapshot.unitScale, 0)).toBe(DEFAULT_BILLING_UNIT_SCALE);
  const model = modelBillableUnits(snapshot, "gpt-5.6-sol", {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  expect(model).toBe(usdToUnits(2, snapshot.unitScale, 0));
  expect(modelBillableUnits(snapshot, "gpt-5.6-sol", undefined)).toBe(0);
  expect(sandboxBillableUnits(snapshot, 1, 4, 8192)).toBe(
    usdToUnits(4 * 0.000014 + 8 * 0.0000045, snapshot.unitScale, 0),
  );
  const marked = rateSnapshotSpec(loadBillingPolicy({ SELFBENCH_BILLING_MARKUP_BPS: "1000" }));
  expect(marked.markupBps).toBe(1000);
  expect(
    modelBillableUnits(marked, "gpt-5.6-sol", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ).toBe(usdToUnits(2, marked.unitScale, 1000));
});

test("managed runs are gated only when Stripe is configured and the subscription is not active", () => {
  const settings = { modelAccess: "managed", sandbox: "managed" };
  expect(managedBillingRefusal(settings, undefined)).toBeUndefined();
  expect(managedBillingRefusal(settings, eligibilityFrom(false))).toBeUndefined();
  expect(
    managedBillingRefusal(
      settings,
      eligibilityFrom(true, { status: "active", cancelAtPeriodEnd: false }),
    ),
  ).toBeUndefined();
  expect(
    managedBillingRefusal(
      settings,
      eligibilityFrom(true, { status: "trialing", cancelAtPeriodEnd: false }),
    ),
  ).toBeUndefined();
  expect(
    managedBillingRefusal({ modelAccess: "credential", sandbox: "modal" }, eligibilityFrom(true)),
  ).toBeUndefined();
  const refused = managedBillingRefusal(settings, eligibilityFrom(true));
  expect(refused?.code).toBe(BILLING_REQUIRED_CODE);
  expect(
    managedBillingRefusal(
      settings,
      eligibilityFrom(true, { status: "past_due", cancelAtPeriodEnd: false }),
    ),
  ).toEqual(refused);
});

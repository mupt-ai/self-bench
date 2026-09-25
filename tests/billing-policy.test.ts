import { expect, test } from "bun:test";
import { loadBillingPolicy, loadStripeConfig } from "../src/generation/billing/config.js";
import { eligibilityFrom, managedBillingRefusal } from "../src/generation/billing/eligibility.js";
import {
  modelBillableUnits,
  rateSnapshotSpec,
  sandboxBillableUnits,
} from "../src/generation/billing/policy.js";

test("Stripe config is all-or-nothing and policy defaults are pass-through", () => {
  expect(loadStripeConfig({})).toBeUndefined();
  expect(
    loadStripeConfig({
      SELFBENCH_STRIPE_WEBHOOK_SECRET_FILE: "/run/stripe/webhook-secret",
    }),
  ).toBeUndefined();
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
    unitScale: 10_000_000,
    markupBps: 0,
    meterEventName: "selfbench_managed_usage",
  });
});

test("integer units come from quantities and frozen rates, not USD estimates", () => {
  const snapshot = rateSnapshotSpec(loadBillingPolicy({}));
  expect(snapshot.unitScale).toBe(10_000_000);
  expect(snapshot.markupBps).toBe(0);
  const model = modelBillableUnits(snapshot, "gpt-6-sol", {
    input: 1_000_000,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // gpt-6-sol input is $2 per million tokens; one unit is $1e-7.
  expect(model).toBe(20_000_000);
  expect(modelBillableUnits(snapshot, "gpt-6-sol", undefined)).toBe(0);
  // 4 vCPU at $0.000014/s plus 8 GiB at $0.0000045/s.
  expect(sandboxBillableUnits(snapshot, 1, 4, 8192)).toBe(920);
  const marked = rateSnapshotSpec(loadBillingPolicy({ SELFBENCH_BILLING_MARKUP_BPS: "1000" }));
  expect(marked.markupBps).toBe(1000);
  expect(
    modelBillableUnits(marked, "gpt-6-sol", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    }),
  ).toBe(22_000_000);
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
  expect(refused?.code).toBe("billing_required");
  expect(
    managedBillingRefusal(
      settings,
      eligibilityFrom(true, { status: "past_due", cancelAtPeriodEnd: false }),
    ),
  ).toEqual(refused);
});

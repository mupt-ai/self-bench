import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingStatusCard, BillingSummary } from "./BillingPage";
import type { BillingStatus } from "./billing";

const status: BillingStatus = {
  configured: true,
  eligible: true,
  status: "active",
  customerId: "cus_test",
  subscriptionId: "sub_test",
  cancelAtPeriodEnd: false,
  currentPeriodEnd: "2026-10-21T00:00:00.000Z",
  canManage: true,
  usage: {
    modelTokens: { input: 1200, output: 300, cacheRead: 80, cacheWrite: 20 },
    tokens: 1600,
    modelBillableUsd: 1.25,
    sandboxSeconds: 125,
    sandboxBillableUsd: 0.08,
  },
};

test("subscription summary exposes access, period, and limit availability", () => {
  const html = renderToStaticMarkup(<BillingStatusCard data={status} />);
  expect(html).toContain('aria-labelledby="subscription-title"');
  for (const value of [
    "Subscription and Limits",
    "Subscription Status",
    "Active",
    "Managed Access",
    "Available",
    "Oct 21, 2026",
    "Usage Limits",
    "Not Available in SelfBench",
  ])
    expect(html).toContain(value);
  expect(html).not.toContain("Status: Active · managed runs are allowed");
});

test("billing summary derives cost visualization from recorded usage", () => {
  const html = renderToStaticMarkup(<BillingSummary data={status} />);
  expect(html).toContain("Total Recorded Cost");
  expect(html).toContain("$1.33");
  expect(html).toContain("Models");
  expect(html).toContain("$1.25");
  expect(html).toContain("Sandboxes");
  expect(html).toContain("$0.08");
  expect(html).toContain('role="img"');
  expect(html).not.toContain("cus_test");
  expect(html).not.toContain("sub_test");
});

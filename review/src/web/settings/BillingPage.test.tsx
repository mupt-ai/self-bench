import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BillingStatusCard } from "./BillingPage";
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
    modelTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tokens: 0,
    sandboxSeconds: 0,
  },
};

test("subscription summary uses compact structured metrics", () => {
  const html = renderToStaticMarkup(<BillingStatusCard data={status} />);
  expect(html).toContain('aria-label="Subscription"');
  for (const value of ["Status", "Active", "Managed Usage", "Allowed", "Oct 21, 2026"])
    expect(html).toContain(value);
  expect(html).not.toContain("Status: Active · managed runs are allowed");
  expect(html).not.toContain(">Stripe</span>");
});

import type { BillingEligibility } from "../../../../src/billing/eligibility";

export interface BillingUsageSummary {
  modelTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  tokens: number;
  modelBillableUsd: number;
  sandboxSeconds: number;
  sandboxBillableUsd: number;
}

import { requestJson } from "../api";

export interface BillingStatus extends BillingEligibility {
  canManage: boolean;
  usage: BillingUsageSummary;
}

export function formatBillingDollars(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2,
  });
}

export function fetchBilling(org: string): Promise<BillingStatus> {
  return requestJson<BillingStatus>(`/api/orgs/${encodeURIComponent(org)}/billing`);
}

export async function startBillingSession(
  org: string,
  kind: "checkout" | "portal",
): Promise<string> {
  const body = await requestJson<{ url: string }>(
    `/api/orgs/${encodeURIComponent(org)}/billing/${kind}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  return body.url;
}

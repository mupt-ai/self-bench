import type { BillingEligibility } from "../../../../src/billing/eligibility";
import { requestJson } from "../api";

export interface BillingStatus extends BillingEligibility {
  canManage: boolean;
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

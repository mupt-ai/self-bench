import type { BillingEligibility } from "../../../../src/generation/billing/eligibility";

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

import { checkSessionExpired } from "../../session-expired";
import { requestJson } from "../api";

export interface BillingStatus extends BillingEligibility {
  canManage: boolean;
  canGrantCredits?: boolean;
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

export interface CreditGrantRequest {
  targetOrg: string;
  amountCents: number;
  reason: string;
  requestId: string;
}

export type CreditGrantResult =
  | { id: string; pending?: false }
  | { pending: true; requestId: string };

export class CreditGrantRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function grantBillingCredit(
  org: string,
  input: CreditGrantRequest,
): Promise<CreditGrantResult> {
  const response = await fetch(`/api/orgs/${encodeURIComponent(org)}/billing/credits`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  checkSessionExpired(response);
  const result = (await response.json()) as CreditGrantResult & { error?: string };
  if (!response.ok)
    throw new CreditGrantRequestError(result.error ?? String(response.status), response.status);
  if (result.pending === true && result.requestId === input.requestId) return result;
  if ("id" in result && typeof result.id === "string" && result.id.startsWith("cbtxn_"))
    return result;
  throw new Error("Stripe credit response was not confirmed. Reconcile before granting again.");
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

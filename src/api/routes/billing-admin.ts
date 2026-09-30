import type { ServerResponse } from "node:http";
import { z } from "zod";
import type { User } from "../../db/users.js";
import { loadBillingPolicy, type StripeConfig } from "../../generation/billing/config.js";
import { fetchOrgMemberships } from "../../third_party/github/oauth.js";
import { subscriptionPeriodStart } from "../../third_party/stripe/client.js";
import type { tenantFor } from "../auth/tenant.js";
import { sendJson } from "../http.js";
import type { BillingRoutesOptions } from "./billing.js";

const refundInput = z
  .object({
    targetOrg: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    reason: z.string().trim().min(1).max(200),
  })
  .strict();

/** Credits and refunds need a live admin of the trusted billing-admin GitHub organization. */
export async function verifiedCreditAdmin(
  options: BillingRoutesOptions,
  org: NonNullable<Awaited<ReturnType<typeof tenantFor>>>,
  user: User,
  response: ServerResponse,
): Promise<boolean> {
  const trustedAdminOrgId = options.creditAdminOrgId;
  if (
    user.apiKey ||
    org.kind !== "org" ||
    !trustedAdminOrgId ||
    org.githubId !== trustedAdminOrgId ||
    !options.githubApiUrl ||
    !options.githubToken
  ) {
    sendJson(response, 403, {
      error: "Only mupt-ai organization admins can grant credits and refunds",
    });
    return false;
  }
  const githubToken = await options.githubToken(user.githubId);
  if (!githubToken) {
    sendJson(response, 403, { error: "Admin membership could not be verified" });
    return false;
  }
  const memberships = await fetchOrgMemberships(
    { githubApiUrl: options.githubApiUrl },
    githubToken,
    options.fetchImpl ?? fetch,
  );
  if (
    !memberships.some(
      (membership) => membership.githubId === trustedAdminOrgId && membership.role === "admin",
    )
  ) {
    sendJson(response, 403, {
      error: "Current GitHub organization admin membership is required",
    });
    return false;
  }
  return true;
}

export async function refundUsage(
  options: BillingRoutesOptions,
  input: unknown,
  user: User,
  response: ServerResponse,
  config: StripeConfig,
): Promise<true> {
  const parsed = refundInput.safeParse(input);
  if (!parsed.success) {
    sendJson(response, 400, { error: "Valid target organization and reason required" });
    return true;
  }
  const target = await options.store.creditTarget(parsed.data.targetOrg);
  if (!target?.subscriptionId) {
    sendJson(response, 404, { error: "Target organization has no Stripe subscription" });
    return true;
  }
  const since = await subscriptionPeriodStart(
    config,
    target.subscriptionId,
    options.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined,
  );
  const policy = loadBillingPolicy();
  const unitScale = options.unitScale ?? policy.unitScale;
  const refunded = await options.store.refundSince({
    orgId: target.orgId,
    customerId: target.customerId,
    adminUserId: user.id,
    reason: parsed.data.reason,
    since,
    unitScale,
    eventName: policy.meterEventName,
  });
  sendJson(response, 200, { refundedUsd: refunded ? refunded.units / unitScale : 0 });
  return true;
}

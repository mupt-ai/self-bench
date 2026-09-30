import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  type BillingStore,
  CreditGrantConflictError,
  CreditGrantLimitError,
} from "../../db/billing.js";
import type { User, UserStore } from "../../db/users.js";
import { loadBillingPolicy, type StripeConfig } from "../../generation/billing/config.js";
import {
  createCheckoutSession,
  createPortalSession,
  createStripeCustomer,
  grantStripeCredit,
  verifyMeteredPrice,
} from "../../third_party/stripe/client.js";
import { applyStripeWebhook, verifyStripeWebhook } from "../../third_party/stripe/webhook.js";
import { stripeWebhookSecret } from "../../third_party/stripe/webhook-secret.js";
import { tenantFor } from "../auth/tenant.js";
import { readBody, sendJson, trustedMutation } from "../http.js";
import { refundUsage, verifiedCreditAdmin } from "./billing-admin.js";

const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/billing(?:\/(checkout|portal|credits|refunds))?$/;
const MAX_CREDIT_GRANT_CENTS = 10_000;
const creditInput = z
  .object({
    targetOrg: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    amountCents: z.number().int().min(1).max(MAX_CREDIT_GRANT_CENTS),
    reason: z.string().trim().min(1).max(200),
    requestId: z.string().uuid(),
  })
  .strict();

export interface BillingRoutesOptions {
  readonly users: UserStore;
  readonly store: BillingStore;
  readonly config?: StripeConfig;
  readonly publicUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly unitScale?: number;
  readonly creditAdminOrgId?: number;
  readonly githubApiUrl?: string;
  readonly githubToken?: (githubId: number) => Promise<string | undefined>;
}

export function createBillingRoutes(options: BillingRoutesOptions) {
  const requestOptions = options.fetchImpl ? { fetchImpl: options.fetchImpl } : undefined;
  return {
    async handle(
      request: IncomingMessage,
      url: URL,
      response: ServerResponse,
      user: User,
    ): Promise<boolean> {
      const match = route.exec(url.pathname);
      if (!match?.[1]) return false;
      response.setHeader("cache-control", "no-store");
      const org = await tenantFor(options.users, user, match[1]);
      if (!org) {
        sendJson(response, 404, { error: "Organization not found" });
        return true;
      }
      if (!match[2] && request.method === "GET") {
        sendJson(response, 200, {
          ...(await options.store.status(org.id)),
          usage: await options.store.usage(org.id),
          canManage: org.role === "admin" && !user.apiKey,
          canGrantCredits:
            org.kind === "org" &&
            !!options.creditAdminOrgId &&
            org.githubId === options.creditAdminOrgId &&
            org.role === "admin" &&
            !user.apiKey &&
            !!options.config,
        });
        return true;
      }
      if (!match[2] || request.method !== "POST") return false;
      if (
        user.apiKey ||
        org.role !== "admin" ||
        !trustedMutation(request, options.publicUrl, user)
      ) {
        sendJson(response, 403, {
          error: "Organization admin and same-origin JSON request required",
        });
        return true;
      }
      if (!options.config) {
        sendJson(response, 503, { error: "Stripe billing is not configured" });
        return true;
      }
      if (match[2] === "credits" || match[2] === "refunds") {
        if (!(await verifiedCreditAdmin(options, org, user, response))) return true;
        let input: unknown;
        try {
          input = JSON.parse((await readBody(request, 4096)).toString());
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          sendJson(response, 400, { error: "Valid JSON required" });
          return true;
        }
        if (match[2] === "refunds")
          return refundUsage(options, input, user, response, options.config);
        const parsed = creditInput.safeParse(input);
        if (!parsed.success) {
          sendJson(response, 400, {
            error:
              "Valid target organization, amount up to $100 in cents, reason, and request ID required",
          });
          return true;
        }
        const target = await options.store.creditTarget(parsed.data.targetOrg);
        if (!target) {
          sendJson(response, 404, { error: "Target organization has no Stripe customer" });
          return true;
        }
        const grantId = parsed.data.requestId;
        let grant: Awaited<ReturnType<BillingStore["beginCreditGrant"]>>;
        try {
          grant = await options.store.beginCreditGrant({
            requestId: grantId,
            adminUserId: user.id,
            targetOrgId: target.orgId,
            amountCents: parsed.data.amountCents,
            reason: parsed.data.reason,
            customerId: target.customerId,
          });
        } catch (error) {
          if (error instanceof CreditGrantConflictError) {
            sendJson(response, 409, { error: error.message });
            return true;
          }
          if (error instanceof CreditGrantLimitError) {
            sendJson(response, 429, { error: error.message });
            return true;
          }
          throw error;
        }
        if (grant.replay && grant.stripeTransactionId) {
          sendJson(response, 200, { id: grant.stripeTransactionId, replay: true });
          return true;
        }
        // Stripe retains idempotency results for at least 24 hours. Retry ambiguous requests
        // with the same body/key within 23 hours; after that, require manual reconciliation.
        if (grant.replay && Date.now() - grant.createdAt.getTime() >= 23 * 60 * 60 * 1000) {
          sendJson(response, 202, { pending: true, requestId: grantId });
          return true;
        }
        const credit = await grantStripeCredit(
          options.config,
          {
            customerId: target.customerId,
            amountCents: parsed.data.amountCents,
            description: `SelfBench credit: ${parsed.data.reason} (${grantId})`,
            idempotencyKey: `selfbench-credit-${grantId}`,
          },
          requestOptions,
        );
        await options.store.finishCreditGrant(grantId, credit.id);
        sendJson(response, 200, { id: credit.id });
        return true;
      }
      if (match[2] === "checkout") {
        try {
          await verifyMeteredPrice(
            options.config,
            options.unitScale ?? loadBillingPolicy().unitScale,
            loadBillingPolicy().meterEventName,
            requestOptions,
          );
        } catch (error) {
          console.error("Stripe metered price verification failed", error);
          sendJson(response, 503, {
            error: "Billing price is not verified. Contact support before starting a subscription.",
          });
          return true;
        }
      }
      let customerId = await options.store.customerId(org.id);
      if (!customerId) {
        const customer = await createStripeCustomer(
          options.config,
          { orgId: org.id, orgLogin: org.login },
          { ...requestOptions, idempotencyKey: `selfbench-org-${org.id}` },
        );
        customerId = await options.store.saveCustomer(org.id, customer.id);
      }
      const billingUrl = `${options.publicUrl}/settings/billing`;
      const session =
        match[2] === "checkout"
          ? await createCheckoutSession(
              options.config,
              {
                customerId,
                orgId: org.id,
                successUrl: `${billingUrl}?checkout=success`,
                cancelUrl: billingUrl,
              },
              requestOptions,
            )
          : await createPortalSession(
              options.config,
              { customerId, returnUrl: billingUrl },
              requestOptions,
            );
      sendJson(response, 200, { url: session.url });
      return true;
    },
    async webhook(request: IncomingMessage, url: URL, response: ServerResponse): Promise<boolean> {
      if (url.pathname !== "/api/stripe/webhook") return false;
      if (request.method !== "POST") return false;
      if (!options.config) {
        sendJson(response, 404, { error: "not found" });
        return true;
      }
      const body = await readBody(request, 1024 * 1024);
      try {
        verifyStripeWebhook(
          body,
          Array.isArray(request.headers["stripe-signature"])
            ? request.headers["stripe-signature"][0]
            : request.headers["stripe-signature"],
          stripeWebhookSecret(options.config),
        );
        await applyStripeWebhook(options.store, body);
        sendJson(response, 200, { received: true });
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Invalid Stripe webhook",
        });
      }
      return true;
    },
  };
}

export type BillingRoutes = ReturnType<typeof createBillingRoutes>;

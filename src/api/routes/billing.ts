import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { BillingStore } from "../../db/billing.js";
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

const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/billing(?:\/(checkout|portal|credits))?$/;
const creditInput = z
  .object({
    targetOrg: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    amountCents: z.number().int().min(1).max(1_000_000),
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
            org.login.toLowerCase() === "mupt-ai" &&
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
      if (match[2] === "credits") {
        if (user.apiKey || org.kind !== "org" || org.login.toLowerCase() !== "mupt-ai") {
          sendJson(response, 403, { error: "Only mupt-ai organization admins can grant credits" });
          return true;
        }
        let input: unknown;
        try {
          input = JSON.parse((await readBody(request, 4096)).toString());
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          sendJson(response, 400, { error: "Valid JSON required" });
          return true;
        }
        const parsed = creditInput.safeParse(input);
        if (!parsed.success) {
          sendJson(response, 400, {
            error: "Valid target organization, amount in cents, and reason required",
          });
          return true;
        }
        const target = await options.store.creditTarget(parsed.data.targetOrg);
        if (!target) {
          sendJson(response, 404, { error: "Target organization has no Stripe customer" });
          return true;
        }
        const grantId = parsed.data.requestId;
        const credit = await grantStripeCredit(
          options.config,
          {
            customerId: target.customerId,
            amountCents: parsed.data.amountCents,
            description: `SelfBench credit: ${parsed.data.reason} (granted by ${user.login}; ${grantId})`,
            idempotencyKey: `selfbench-credit-${grantId}`,
          },
          requestOptions,
        );
        sendJson(response, 200, { id: credit.id });
        return true;
      }
      if (match[2] === "checkout") {
        try {
          await verifyMeteredPrice(
            options.config,
            options.unitScale ?? loadBillingPolicy().unitScale,
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

import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, sendJson, trustedMutation } from "../api/http.js";
import type { User, UserStore } from "../auth/users.js";
import { tenantFor } from "../site/tenant.js";
import type { StripeConfig } from "./config.js";
import type { BillingStore } from "./store.js";
import { createCheckoutSession, createPortalSession, createStripeCustomer } from "./stripe.js";
import { applyStripeWebhook, verifyStripeWebhook } from "./webhook.js";

const route = /^\/api\/orgs\/([A-Za-z0-9_.-]+)\/billing(?:\/(checkout|portal))?$/;

export interface BillingRoutesOptions {
  readonly users: UserStore;
  readonly store: BillingStore;
  readonly config?: StripeConfig;
  readonly publicUrl: string;
  readonly fetchImpl?: typeof fetch;
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
          canManage: org.role === "admin" && !user.apiKey,
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
          options.config.webhookSecret,
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

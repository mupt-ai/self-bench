import { readFileSync } from "node:fs";
import type { StripeConfig } from "../../generation/billing/config.js";

/** Reads a direct or sidecar-managed webhook secret at request time. */
export function stripeWebhookSecret(config: StripeConfig): string {
  if (config.webhookSecret) return config.webhookSecret;
  if (config.webhookSecretFile) {
    try {
      const secret = readFileSync(config.webhookSecretFile, "utf8").trim();
      if (secret) return secret;
    } catch {
      // The Stripe CLI may not have finished bootstrapping its listener yet.
    }
  }
  throw new Error("Stripe webhook signing secret is not available yet");
}

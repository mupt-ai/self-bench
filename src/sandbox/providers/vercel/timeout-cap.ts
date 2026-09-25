import { providerTimeoutCap } from "../../timeout.js";

// Vercel keeps a sandbox alive for at most 2 hours on paid teams and 45 minutes on Hobby.
const STANDARD_VERCEL_TIMEOUT_CAP_MS = 2 * 60 * 60 * 1_000;

/** A configured Vercel timeout cap, defaulting to the paid-team ceiling. */
export function vercelTimeoutCap(value: string | undefined): number {
  return providerTimeoutCap(value, STANDARD_VERCEL_TIMEOUT_CAP_MS);
}

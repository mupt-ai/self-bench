import { providerTimeoutCap } from "../../timeout.js";

// Vercel keeps a sandbox alive for at most 2 hours on paid teams and 45 minutes on Hobby.
export const STANDARD_VERCEL_TIMEOUT_CAP_MS = 2 * 60 * 60 * 1_000;
export const HOBBY_VERCEL_TIMEOUT_CAP_MS = 45 * 60 * 1_000;

/** A configured Vercel timeout cap, defaulting to the paid-team ceiling. */
export function vercelTimeoutCap(value: string | undefined): number {
  return providerTimeoutCap(value, STANDARD_VERCEL_TIMEOUT_CAP_MS);
}

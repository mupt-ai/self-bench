import { providerTimeoutCap } from "../../timeout.js";

// E2B keeps a sandbox alive for at most 24 hours on Pro and 1 hour on Hobby.
export const STANDARD_E2B_TIMEOUT_CAP_MS = 24 * 60 * 60 * 1_000;
export const HOBBY_E2B_TIMEOUT_CAP_MS = 60 * 60 * 1_000;

/** A configured E2B timeout cap, defaulting to the Hobby-compatible one hour. */
export function e2bTimeoutCap(value: string | undefined): number {
  return value === undefined
    ? HOBBY_E2B_TIMEOUT_CAP_MS
    : providerTimeoutCap(value, STANDARD_E2B_TIMEOUT_CAP_MS);
}

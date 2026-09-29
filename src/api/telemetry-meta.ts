import { envValue, telemetryEnvironment, telemetryRelease } from "../lib/telemetry/common.js";
import { posthogHost } from "../lib/telemetry/posthog.js";
import { escapeAttribute } from "./http.js";

/**
 * What the app and selfbench.dev need to start Sentry and PostHog (`review/src/telemetry.ts`),
 * as a tag the server adds to each page's head. Read at runtime so one image serves dev and
 * prod. Empty when neither is configured. Both values are public by design: a browser DSN and
 * a PostHog project key only allow sending events.
 */
export function telemetryMetaTag(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const sentryDsn = envValue(env, "SENTRY_BROWSER_DSN");
  const posthogKey = envValue(env, "POSTHOG_API_KEY");
  if (!sentryDsn && !posthogKey) return "";
  const config = {
    environment: telemetryEnvironment(env),
    release: telemetryRelease(),
    sentryDsn,
    ...(posthogKey ? { posthogKey, posthogHost: posthogHost(env) } : {}),
  };
  return `<meta name="selfbench-telemetry" content="${escapeAttribute(JSON.stringify(config))}" />`;
}

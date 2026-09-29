import * as Sentry from "@sentry/node";
import { envValue, telemetryEnvironment, telemetryRelease } from "./common.js";

/**
 * Error reporting for the API and the worker, on when `SENTRY_DSN` is set. Only errors: no
 * tracing. Reports carry a request's method and path but never its query string, headers,
 * cookies, body, or stack-frame variables.
 */
export function initSentry(
  service: "api" | "worker",
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const dsn = envValue(env, "SENTRY_DSN");
  if (!dsn) return;
  const release = telemetryRelease();
  Sentry.init({
    dsn,
    environment: telemetryEnvironment(env),
    ...(release ? { release } : {}),
    initialScope: { tags: { service } },
    // Requests carry OAuth codes, session cookies, and API keys; locals carry GitHub tokens.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
  });
}

/** Reports an error that was handled (logged, answered 500, retried); no-op without Sentry. */
export function reportError(
  error: unknown,
  context: { readonly tags?: Record<string, string | number> } = {},
): void {
  Sentry.captureException(error, context.tags ? { tags: context.tags } : undefined);
}

/** Sends what is queued; call before the process exits. */
export async function closeSentry(): Promise<void> {
  await Sentry.close(2_000);
}

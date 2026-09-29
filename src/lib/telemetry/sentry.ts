import * as Sentry from "@sentry/node";
import { redactSecrets } from "../redact.js";
import { envValue, telemetryEnvironment, telemetryRelease } from "./common.js";

/** A failure a retry loop hits on every pass is reported once per this window. */
const REPEAT_WINDOW_MS = 60 * 60 * 1000;
const lastReported = new Map<string, number>();

/**
 * Error reporting for the API and the worker, on when `SENTRY_DSN` is set. Only errors: no
 * tracing. Reports carry a request's method and path but never its query string, headers,
 * cookies, body, or stack-frame variables, and error messages pass through `redactSecrets`
 * (command output can carry tokens).
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
    // Sentry's default only warns; keep Node's own behavior, where an unhandled rejection exits.
    integrations: [Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
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
    beforeSend: redactEvent,
    beforeBreadcrumb: (breadcrumb) => {
      if (breadcrumb.message) breadcrumb.message = redactSecrets(breadcrumb.message);
      // Console breadcrumbs repeat the message as raw arguments.
      if (breadcrumb.category === "console") delete breadcrumb.data;
      return breadcrumb;
    },
  });
}

/**
 * Reports an error that was handled (logged, answered 500, retried); no-op without Sentry. With a
 * `repeatKey`, a failure a loop retries every few seconds is reported once an hour.
 */
export function reportError(
  error: unknown,
  context: { readonly tags?: Record<string, string | number>; readonly repeatKey?: string } = {},
): void {
  if (context.repeatKey) {
    const now = Date.now();
    const last = lastReported.get(context.repeatKey);
    if (last !== undefined && now - last < REPEAT_WINDOW_MS) return;
    if (lastReported.size > 1_000) lastReported.clear();
    lastReported.set(context.repeatKey, now);
  }
  Sentry.captureException(error, context.tags ? { tags: context.tags } : undefined);
}

/** Sends what is queued; call before the process exits. */
export async function closeSentry(): Promise<void> {
  await Sentry.close(2_000);
}

function redactEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactSecrets(exception.value);
  }
  if (event.message) event.message = redactSecrets(event.message);
  if (event.logentry?.message) event.logentry.message = redactSecrets(event.logentry.message);
  return event;
}

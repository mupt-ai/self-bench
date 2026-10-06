import { PostHog } from "posthog-node";
import { envValue, telemetryEnvironment } from "./common.js";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/** Who did it: a signed-in user, by browser session or API key. */
interface Actor {
  readonly githubId: number;
  readonly login: string;
  readonly apiKey?: unknown;
}

/** Product events the server is the authority on; the browser captures page views and clicks. */
type ServerEvent =
  | "user signed in"
  | "repo connected"
  | "batch started"
  | "pull request task started"
  | "comparison started"
  | "group evaluation started"
  | "release published"
  | "group release published";

let client: PostHog | undefined;
let environment = "local";

/** Server-side product analytics, on when `POSTHOG_API_KEY` is set. */
export function initAnalytics(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const apiKey = envValue(env, "POSTHOG_API_KEY");
  if (!apiKey || client) return;
  environment = telemetryEnvironment(env);
  client = new PostHog(apiKey, {
    host: posthogHost(env),
    flushAt: 20,
    flushInterval: 10_000,
    requestTimeout: 2_000,
    fetchRetryCount: 1,
  });
}

/**
 * The same person the browser identifies (`review/src/telemetry.ts`): GitHub ids survive a
 * rename, logins do not.
 */
function distinctIdFor(githubId: number): string {
  return `github:${githubId}`;
}

export function track(
  actor: Actor,
  event: ServerEvent,
  properties: Record<string, string | number | boolean | undefined> = {},
  org?: { readonly login: string },
): void {
  if (!client) return;
  client.capture({
    distinctId: distinctIdFor(actor.githubId),
    event,
    properties: {
      ...properties,
      via: actor.apiKey ? "api-key" : "session",
      environment,
      $set: { login: actor.login },
    },
    ...(org ? { groups: { organization: org.login.toLowerCase() } } : {}),
  });
}

/** How a generation was configured: models, reasoning, and whose accounts pay. */
export function generationProperties(settings: {
  readonly authorModel: string;
  readonly verifierModel: string;
  readonly reasoning: string;
  readonly modelAccess: string;
  readonly sandbox: string;
}): Record<string, string> {
  return {
    author_model: settings.authorModel,
    verifier_model: settings.verifierModel,
    reasoning: settings.reasoning,
    model_access: settings.modelAccess,
    sandbox: settings.sandbox,
  };
}

export async function closeAnalytics(): Promise<void> {
  const active = client;
  client = undefined;
  await active?.shutdown(2_000);
}

export function posthogHost(env: Readonly<Record<string, string | undefined>>): string {
  return envValue(env, "POSTHOG_HOST")?.replace(/\/+$/, "") ?? DEFAULT_POSTHOG_HOST;
}

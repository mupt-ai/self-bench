/**
 * Sentry and PostHog in the browser, for the app and selfbench.dev. The server names them in a
 * `selfbench-telemetry` meta tag (src/api/telemetry-meta.ts); without one, as under the Vite dev
 * server or on a stack without keys, nothing loads. Each SDK is its own chunk, fetched only when
 * configured, so neither weighs on a page that does not use it.
 */
interface TelemetryConfig {
  environment: string;
  release?: string;
  sentryDsn?: string;
  posthogKey?: string;
  posthogHost?: string;
}

interface Person {
  githubId: number;
  login: string;
  name?: string;
}

type SentryClient = typeof import("./sentry-browser");
type PostHogClient = typeof import("posthog-js").default;

let sentry: SentryClient | undefined;
let posthog: PostHogClient | undefined;
/** Who is signed in, applied to each SDK as it loads; null once they sign out. */
let person: Person | null | undefined;
/** Errors from before Sentry finished loading. */
const early: unknown[] = [];
let sentryPending = false;

export function startTelemetry(site: "app" | "public-site"): void {
  const config = readConfig();
  if (!config) return;
  const release = config.release ? { release: config.release } : {};
  if (config.sentryDsn) {
    const dsn = config.sentryDsn;
    sentryPending = true;
    void import("./sentry-browser").then((sdk) => {
      sdk.init({
        dsn,
        environment: config.environment,
        ...release,
        initialScope: { tags: { site } },
      });
      sentry = sdk;
      sentryPending = false;
      applyPerson();
      for (const error of early.splice(0)) sdk.captureException(error);
    });
  }
  if (config.posthogKey) {
    const key = config.posthogKey;
    void import("posthog-js").then(({ default: client }) => {
      client.init(key, {
        ...(config.posthogHost ? { api_host: config.posthogHost } : {}),
        defaults: "2026-08-30",
        person_profiles: "identified_only",
      });
      client.register({ site, environment: config.environment, ...release });
      posthog = client;
      applyPerson();
    });
  }
}

/** Reports an error a boundary caught; without Sentry, a no-op. */
export function reportError(error: unknown): void {
  if (sentry) sentry.captureException(error);
  else if (sentryPending && early.length < 20) early.push(error);
}

/** The signed-in user, by the same id the server's events use (src/lib/telemetry/posthog.ts). */
export function identifyPerson(user: Person): void {
  person = user;
  applyPerson();
}

/** On sign-out: later events in this browser are no longer this person's. */
export function forgetPerson(): void {
  person = null;
  applyPerson();
}

function applyPerson(): void {
  if (person === undefined) return;
  if (person === null) {
    sentry?.setUser(null);
    posthog?.reset();
    return;
  }
  const id = `github:${person.githubId}`;
  sentry?.setUser({ id, username: person.login });
  posthog?.identify(id, { login: person.login, ...(person.name ? { name: person.name } : {}) });
}

function readConfig(): TelemetryConfig | undefined {
  const content = document.querySelector<HTMLMetaElement>(
    'meta[name="selfbench-telemetry"]',
  )?.content;
  if (!content) return undefined;
  try {
    return JSON.parse(content) as TelemetryConfig;
  } catch {
    return undefined;
  }
}

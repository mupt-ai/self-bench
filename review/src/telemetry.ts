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

/**
 * The app's paths and page titles name repositories, private ones included, and a task's run id
 * carries the repository too. Outside selfbench.dev, analytics sees only the route.
 */
const REPO_PATH = /\/repos\/[^/?#\s"'\\]+\/[^/?#\s"'\\]+(\/tasks\/[^/?#\s"'\\]+)?/g;

function withoutRepoNames<T>(value: T): T {
  const json = JSON.stringify(value).replace(
    REPO_PATH,
    (_, task?: string) => `/repos/:owner/:name${task ? "/tasks/:runId" : ""}`,
  );
  return JSON.parse(json) as T;
}

export function startTelemetry(site: "app" | "public-site"): void {
  const config = readConfig();
  if (!config) return;
  const release = config.release ? { release: config.release } : {};
  const app = site === "app";
  if (config.sentryDsn) {
    const dsn = config.sentryDsn;
    sentryPending = true;
    // Until the SDK has loaded and installed its own handlers, keep what the page throws.
    const keep = (event: ErrorEvent | PromiseRejectionEvent) =>
      reportError(event instanceof ErrorEvent ? (event.error ?? event.message) : event.reason);
    window.addEventListener("error", keep);
    window.addEventListener("unhandledrejection", keep);
    void import("./sentry-browser").then((sdk) => {
      sdk.init({
        dsn,
        environment: config.environment,
        ...release,
        initialScope: { tags: { site } },
        ...(app ? { beforeSend: withoutRepoNames, beforeBreadcrumb: withoutRepoNames } : {}),
      });
      window.removeEventListener("error", keep);
      window.removeEventListener("unhandledrejection", keep);
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
        ...(app
          ? {
              // The app shows API key secrets and private repository names on screen.
              disable_session_recording: true,
              mask_all_text: true,
              mask_all_element_attributes: true,
              // Flag requests send the person's first URL, which no event hook sees. The app
              // uses no flags or remote config, so it makes none.
              advanced_disable_flags: true,
              before_send: (event) => {
                if (!event) return event;
                const { title: _, ...properties } = event.properties;
                return {
                  ...event,
                  properties: withoutRepoNames(properties),
                  ...(event.$set ? { $set: withoutRepoNames(event.$set) } : {}),
                  ...(event.$set_once ? { $set_once: withoutRepoNames(event.$set_once) } : {}),
                };
              },
            }
          : {}),
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

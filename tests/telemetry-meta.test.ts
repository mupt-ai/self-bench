import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { telemetryMetaTag } from "../src/api/telemetry-meta.js";

/** The config as a browser reads it: the meta tag's content, parsed by an HTML parser. */
function pageConfig(tag: string): unknown {
  const { document } = new Window();
  document.head.innerHTML = tag;
  const content = document
    .querySelector('meta[name="selfbench-telemetry"]')
    ?.getAttribute("content");
  return content ? JSON.parse(content) : undefined;
}

test("pages load no SDK when neither browser Sentry nor PostHog is configured", () => {
  // The server's DSN is not the browser's: it reports into the backend project.
  expect(telemetryMetaTag({ SENTRY_DSN: "https://server@sentry.invalid/1" })).toBe("");
});

test("pages get the browser DSN, the PostHog key and host, and the environment", () => {
  const tag = telemetryMetaTag({
    SENTRY_DSN: "https://server@sentry.invalid/1",
    SENTRY_BROWSER_DSN: "https://browser@sentry.invalid/2",
    POSTHOG_API_KEY: "phc_test",
    SELFBENCH_ENVIRONMENT: "prod",
  });
  expect(pageConfig(tag)).toMatchObject({
    environment: "prod",
    sentryDsn: "https://browser@sentry.invalid/2",
    posthogKey: "phc_test",
    posthogHost: "https://us.i.posthog.com",
  });
});

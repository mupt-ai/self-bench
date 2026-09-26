import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const composeEmpty = (name: string): string => `\${${name}:-}`;

type ComposeService = {
  readonly environment?: Readonly<Record<string, string>>;
  readonly image?: string;
  readonly profiles?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
};

type ComposeDocument = {
  readonly name?: string;
  readonly services: Readonly<Record<string, ComposeService>>;
};

describe("Compose provider credential boundary", () => {
  let source: string;
  let compose: ComposeDocument;
  let api: Readonly<Record<string, string>>;
  let worker: Readonly<Record<string, string>>;

  beforeAll(async () => {
    source = await Bun.file(resolve(import.meta.dir, "../compose.yaml")).text();
    compose = Bun.YAML.parse(source) as ComposeDocument;
    api = compose.services.api?.environment ?? {};
    worker = compose.services.worker?.environment ?? {};
  });

  test("defines one shared environment and preserves the checkout sandbox image on both services", () => {
    expect(source.match(/^x-selfbench-environment:/gm)).toHaveLength(1);
    expect(compose.name).toBeUndefined();
    for (const service of ["api", "worker"]) {
      expect(compose.services[service]?.environment).toMatchObject({
        SELFBENCH_DOCKER_IMAGE: `\${SELFBENCH_DOCKER_IMAGE:-selfbench-sandbox:local}`,
      });
      expect(compose.services[service]?.image).toBe(`\${COMPOSE_PROJECT_NAME}-selfbench`);
    }
    expect(compose.services.api?.ports).toEqual(["127.0.0.1::8080"]);
    expect(compose.services.temporal?.ports).toEqual(["127.0.0.1::7233"]);
    expect(compose.services.sandbox).toMatchObject({
      image: `\${SELFBENCH_DOCKER_IMAGE:-selfbench-sandbox:local}`,
      profiles: ["sandbox"],
    });
    expect(compose.services.stripe).toMatchObject({
      image: "stripe/stripe-cli:v1.51.0",
      profiles: ["stripe"],
      environment: { STRIPE_API_KEY: composeEmpty("SELFBENCH_STRIPE_SECRET_KEY") },
    });
  });

  test("shares E2B run metadata with the API but gives control credentials only to the worker", () => {
    expect(api).toMatchObject({
      SELFBENCH_E2B_TEMPLATE: composeEmpty("SELFBENCH_E2B_TEMPLATE"),
      SELFBENCH_E2B_TIMEOUT_CAP: composeEmpty("SELFBENCH_E2B_TIMEOUT_CAP"),
    });
    expect(api).not.toHaveProperty("E2B_API_KEY");
    expect(api).not.toHaveProperty("E2B_DOMAIN");
    expect(worker).toMatchObject({
      SELFBENCH_E2B_TEMPLATE: composeEmpty("SELFBENCH_E2B_TEMPLATE"),
      SELFBENCH_E2B_TIMEOUT_CAP: composeEmpty("SELFBENCH_E2B_TIMEOUT_CAP"),
      E2B_API_KEY: composeEmpty("E2B_API_KEY"),
      E2B_DOMAIN: composeEmpty("E2B_DOMAIN"),
    });
  });

  test("workers get no host model or Stripe credentials", () => {
    expect(worker).not.toHaveProperty("OPENAI_API_KEY");
    expect(worker).not.toHaveProperty("SELFBENCH_PI_AUTH_JSON");
    expect(api).toMatchObject({
      SELFBENCH_STRIPE_SECRET_KEY: composeEmpty("SELFBENCH_STRIPE_SECRET_KEY"),
      SELFBENCH_STRIPE_WEBHOOK_SECRET: composeEmpty("SELFBENCH_STRIPE_WEBHOOK_SECRET"),
      SELFBENCH_STRIPE_PRICE_ID: composeEmpty("SELFBENCH_STRIPE_PRICE_ID"),
    });
    expect(worker).not.toHaveProperty("SELFBENCH_STRIPE_SECRET_KEY");
    expect(worker).not.toHaveProperty("SELFBENCH_STRIPE_WEBHOOK_SECRET");
    expect(worker).not.toHaveProperty("SELFBENCH_STRIPE_PRICE_ID");
    expect(compose.services.stripe?.environment).toMatchObject({
      STRIPE_API_KEY: composeEmpty("SELFBENCH_STRIPE_SECRET_KEY"),
    });
    expect(compose.services.stripe?.environment).not.toHaveProperty(
      "SELFBENCH_STRIPE_WEBHOOK_SECRET",
    );
    expect(compose.services.api?.environment).toMatchObject({
      SELFBENCH_STRIPE_WEBHOOK_SECRET_FILE: "/run/selfbench-stripe/webhook-secret",
    });
    expect(compose.services.worker?.volumes).toContain(
      `\${SELFBENCH_MODAL_CONFIG_PATH:-/dev/null}:/home/node/.modal.toml:ro`,
    );
  });

  test("shares the site database with the worker but keeps GitHub sign-in secrets on the API", () => {
    const databaseUrl = "postgres://selfbench:selfbench@site-postgres:5432/selfbench";
    expect(api).toMatchObject({
      SELFBENCH_DATABASE_URL: databaseUrl,
      SELFBENCH_EVAL_CREDENTIAL_KEY: composeEmpty("SELFBENCH_EVAL_CREDENTIAL_KEY"),
      GITHUB_OAUTH_CLIENT_ID: composeEmpty("GITHUB_OAUTH_CLIENT_ID"),
      GITHUB_OAUTH_CLIENT_SECRET: composeEmpty("GITHUB_OAUTH_CLIENT_SECRET"),
      SELFBENCH_SESSION_SECRET: composeEmpty("SELFBENCH_SESSION_SECRET"),
    });
    expect(worker).toMatchObject({
      SELFBENCH_DATABASE_URL: databaseUrl,
      SELFBENCH_EVAL_CREDENTIAL_KEY: composeEmpty("SELFBENCH_EVAL_CREDENTIAL_KEY"),
    });
    expect(worker).not.toHaveProperty("GITHUB_OAUTH_CLIENT_ID");
    expect(worker).not.toHaveProperty("GITHUB_OAUTH_CLIENT_SECRET");
    expect(worker).not.toHaveProperty("SELFBENCH_SESSION_SECRET");
  });
});

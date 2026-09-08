import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const composeEmpty = (name: string): string => `\${${name}:-}`;

type ComposeService = {
  readonly environment?: Readonly<Record<string, string>>;
};

type ComposeDocument = {
  readonly services: Readonly<Record<string, ComposeService>>;
};

describe("Compose provider credential boundary", () => {
  test("shares E2B run metadata with the API but gives control credentials only to the worker", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../compose.yaml")).text();
    const compose = Bun.YAML.parse(source) as ComposeDocument;
    const api = compose.services.api?.environment ?? {};
    const worker = compose.services.worker?.environment ?? {};

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

  test("shares the site database with the worker but keeps GitHub sign-in secrets on the API", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../compose.yaml")).text();
    const compose = Bun.YAML.parse(source) as ComposeDocument;
    const api = compose.services.api?.environment ?? {};
    const worker = compose.services.worker?.environment ?? {};

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

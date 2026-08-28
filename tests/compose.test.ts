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
});

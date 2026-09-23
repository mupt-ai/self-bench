import { expect, test } from "bun:test";
import { providerCredentialEnvironment } from "../../src/sandbox/provider-environment.js";

test("stored credentials become each provider's own variables", () => {
  expect(providerCredentialEnvironment("modal", { value: "s", tokenId: "id" })).toEqual({
    MODAL_TOKEN_ID: "id",
    MODAL_TOKEN_SECRET: "s",
  });
  expect(providerCredentialEnvironment("e2b", { value: "k", domain: undefined })).toEqual({
    E2B_API_KEY: "k",
  });
  expect(providerCredentialEnvironment("e2b", { value: "k", domain: "e2b.example" })).toEqual({
    E2B_API_KEY: "k",
    E2B_DOMAIN: "e2b.example",
  });
  expect(providerCredentialEnvironment("daytona", { value: "d" })).toEqual({
    DAYTONA_API_KEY: "d",
  });
  expect(providerCredentialEnvironment("docker", { value: "x" })).toEqual({});
});

test("Harbor credentials use the dedicated verification variables", () => {
  expect(providerCredentialEnvironment("e2b", { value: "k" }, "harbor")).toEqual({
    SELFBENCH_HARBOR_E2B_API_KEY: "k",
  });
  expect(
    providerCredentialEnvironment(
      "vercel",
      { value: "t", teamId: "team", projectId: "p" },
      "harbor",
    ),
  ).toEqual({
    SELFBENCH_HARBOR_VERCEL_TOKEN: "t",
    SELFBENCH_HARBOR_VERCEL_TEAM_ID: "team",
    SELFBENCH_HARBOR_VERCEL_PROJECT_ID: "p",
  });
});

test("incomplete Modal and Vercel credentials are rejected", () => {
  expect(() => providerCredentialEnvironment("modal", { value: "s" })).toThrow("Modal");
  expect(() => providerCredentialEnvironment("vercel", { value: "t", teamId: "team" })).toThrow(
    "Vercel",
  );
});

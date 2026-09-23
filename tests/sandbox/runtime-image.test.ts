import { expect, test } from "bun:test";
import { managedE2BTemplateReference } from "../../src/sandbox/providers/e2b/managed-template.js";
import { sandboxImageEnvironment } from "../../src/sandbox/runtime-image.js";

test("each hosted provider selects its runtime from Dockerfile.sandbox", () => {
  expect(sandboxImageEnvironment("modal", "ignored")).toEqual({});
  expect(sandboxImageEnvironment("vercel", undefined)).toEqual({});
  expect(sandboxImageEnvironment("vercel", "img@sha256:1")).toEqual({
    SELFBENCH_VERCEL_IMAGE: "img@sha256:1",
  });
  expect(sandboxImageEnvironment("e2b", undefined)).toEqual({
    SELFBENCH_E2B_TEMPLATE: managedE2BTemplateReference(),
  });
  expect(sandboxImageEnvironment("e2b", "custom:v1")).toEqual({
    SELFBENCH_E2B_TEMPLATE: "custom:v1",
  });
});

import { describe, expect, test } from "bun:test";
import { removeEmptyModalCredentialOverrides } from "../src/modal-auth.js";

describe("Modal authentication environment", () => {
  test("removes empty overrides so SDKs can use the mounted profile", () => {
    const environment: NodeJS.ProcessEnv = {
      MODAL_TOKEN_ID: "",
      MODAL_TOKEN_SECRET: "   ",
      OTHER_VALUE: "kept",
    };

    removeEmptyModalCredentialOverrides(environment);

    expect(environment).toEqual({ OTHER_VALUE: "kept" });
  });

  test("preserves explicit local token credentials", () => {
    const environment: NodeJS.ProcessEnv = {
      MODAL_TOKEN_ID: "local-id",
      MODAL_TOKEN_SECRET: "local-secret",
    };

    removeEmptyModalCredentialOverrides(environment);

    expect(environment).toEqual({
      MODAL_TOKEN_ID: "local-id",
      MODAL_TOKEN_SECRET: "local-secret",
    });
  });
});

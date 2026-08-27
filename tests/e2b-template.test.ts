import { describe, expect, test } from "bun:test";
import { normalizeE2BDomain } from "../src/e2b-template.js";

describe("E2B domain normalization", () => {
  test("accepts default and non-default ports", () => {
    expect(normalizeE2BDomain("e2b.example.com:443")).toBe("e2b.example.com:443");
    expect(normalizeE2BDomain("e2b.example.com:8443")).toBe("e2b.example.com:8443");
  });

  test("rejects malformed hostnames and invalid ports", () => {
    for (const domain of [
      "foo..bar",
      "-foo.example.com",
      "foo-.example.com",
      "foo_example.com",
      "e2b.example.com:0",
      "e2b.example.com:65536",
      "e2b.example.com:abc",
    ]) {
      expect(() => normalizeE2BDomain(domain)).toThrow();
    }
  });
});

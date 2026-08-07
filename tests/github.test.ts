import { describe, expect, test } from "bun:test";
import { assertPullRequestBelongsToRepository } from "../src/github.js";

describe("GitHub repository boundaries", () => {
  test("accepts canonical pull request URLs for HTTPS and SSH remotes", () => {
    expect(() =>
      assertPullRequestBelongsToRepository(
        "https://github.com/vercel/next.js.git",
        "https://github.com/vercel/next.js/pull/123",
        123,
      ),
    ).not.toThrow();
    expect(() =>
      assertPullRequestBelongsToRepository(
        "git@github.com:vercel/next.js.git",
        "https://github.com/vercel/next.js/pull/123",
        123,
      ),
    ).not.toThrow();
  });

  test("rejects cross-repository and mismatched pull requests", () => {
    expect(() =>
      assertPullRequestBelongsToRepository(
        "https://github.com/vercel/next.js.git",
        "https://github.com/mupt-ai/selfbench/pull/20",
        20,
      ),
    ).toThrow("does not match vercel/next.js#20");
    expect(() =>
      assertPullRequestBelongsToRepository(
        "https://github.com/vercel/next.js.git",
        "https://github.com/vercel/next.js/pull/20",
        21,
      ),
    ).toThrow("does not match vercel/next.js#21");
  });
});

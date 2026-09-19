import { describe, expect, test } from "bun:test";
import { isSitePage } from "../src/api/http.js";

describe("site page routing", () => {
  test.each([
    "/repos/vercel/next.js",
    "/repos/vercel/next.js/",
    "/repos/vercel/next.js/results",
    "/repos/vercel/next.js/batches/batch.v1",
    "/repos/vercel/next.js/tasks/run-one/task.v1",
    "/repos/example/.github",
    "/repos/vercel/next%2Ejs",
    "/",
    "/login",
    "/settings/credentials",
  ])("serves the app shell on direct navigation to %s", (pathname) => {
    expect(isSitePage(pathname)).toBe(true);
  });

  test.each([
    "/api",
    "/api/github-repos/vercel/next.js",
    "/auth/github/callback",
    "/v1/runs",
    "/assets/app.js",
    "/assets/missing",
    "/dari-logo.svg",
    "/favicon.ico",
    "/missing.js",
  ])("keeps API, auth, and asset requests out of the app shell: %s", (pathname) => {
    expect(isSitePage(pathname)).toBe(false);
  });
});

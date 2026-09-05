import { expect, test } from "bun:test";
import { listMergedPullRequests } from "../src/site/pr-list.js";

test("merged PR search uses the user's token and reports partial results at the search cap", async () => {
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer user-token");
    const url = new URL(String(input));
    expect(url.searchParams.get("q")).toBe("repo:owner/repo is:pr is:merged");
    expect(url.searchParams.get("per_page")).toBe("20");
    expect(url.searchParams.get("page")).toBe("50");
    return Response.json({ total_count: 2000, incomplete_results: true, items: [] });
  }) as unknown as typeof fetch;
  expect(
    await listMergedPullRequests(
      { githubApiUrl: "https://api.github.example" },
      "user-token",
      "owner/repo",
      50,
      fetchImpl,
    ),
  ).toEqual({ pullRequests: [], nextPage: null, incomplete: true });
});

test("GitHub failures are not disguised as an empty list", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const fetchImpl = (async () =>
      new Response("sensitive upstream body", { status })) as unknown as typeof fetch;
    await expect(
      listMergedPullRequests(
        { githubApiUrl: "https://api.github.example" },
        "user-token",
        "owner/repo",
        1,
        fetchImpl,
      ),
    ).rejects.toThrow(`GitHub pull request listing failed (${status})`);
  }
});

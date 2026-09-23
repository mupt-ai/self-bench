import { expect, test } from "bun:test";
import { fetchBatchPullRequests } from "../../src/third_party/github/batch-pull-requests.js";

const pr = (number: number, bot = false) => ({
  number,
  title: "Implement feature",
  body: "Request",
  url: `https://github.com/o/r/pull/${number}`,
  isDraft: false,
  additions: 30,
  deletions: 0,
  changedFiles: 1,
  author: { login: "someone", __typename: bot ? "Bot" : "User" },
});
const page = (nodes: unknown[], hasNextPage = false, endCursor: string | null = null) =>
  Response.json({
    data: { repository: { pullRequests: { nodes, pageInfo: { hasNextPage, endCursor } } } },
  });
test("uses direct GraphQL with bounded cursor pages, preserving filtering", async () => {
  const calls: unknown[] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    calls.push(body.variables);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test");
    expect(body.query).toContain("states: [MERGED]");
    return calls.length === 1 ? page([pr(3), pr(2, true)], true, "next") : page([pr(1)]);
  }) as typeof fetch;
  const result = await fetchBatchPullRequests({
    repositoryUrl: "https://github.com/o/r",
    token: "test",
    limit: 3,
    fetchImpl,
  });
  expect(calls).toEqual([
    { owner: "o", name: "r", first: 3, after: null },
    { owner: "o", name: "r", first: 1, after: "next" },
  ]);
  expect(result.map((row) => row.sourcePr)).toEqual([3, 1]);
});
test("fails closed on auth, GraphQL partial data and repeated cursors", async () => {
  for (const response of [
    new Response("", { status: 401 }),
    Response.json({ errors: [{ message: "hidden" }], data: {} }),
  ]) {
    await expect(
      fetchBatchPullRequests({
        repositoryUrl: "https://github.com/o/r",
        token: "test",
        fetchImpl: async () => response,
      }),
    ).rejects.toThrow();
  }
  await expect(
    fetchBatchPullRequests({
      repositoryUrl: "https://github.com/o/r",
      token: "test",
      fetchImpl: async () => page([pr(1)], true, "same"),
    }),
  ).rejects.toThrow("did not advance");
});
test("pre-abort never sends credentials or a request", async () => {
  let calls = 0;
  await expect(
    fetchBatchPullRequests({
      repositoryUrl: "https://github.com/o/r",
      token: "test",
      signal: AbortSignal.abort(),
      fetchImpl: async () => {
        calls++;
        return page([]);
      },
    }),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("null descriptions and unavailable diff stats do not discard unrelated PRs", async () => {
  const result = await fetchBatchPullRequests({
    repositoryUrl: "https://github.com/o/r",
    token: "test",
    fetchImpl: async () =>
      page([
        { ...pr(1), body: null },
        { ...pr(2), additions: null, deletions: null, changedFiles: null },
        pr(3),
      ]),
  });
  expect(result.map((row) => row.sourcePr)).toEqual([1, 3]);
});

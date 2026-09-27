import { afterEach, describe, expect, test } from "bun:test";
import { signedIn } from "../support/sign-in.js";
import {
  type AuthServer,
  type FakeGitHubOptions,
  fakeGitHub,
  startAuthServer,
  testAuthConfig,
} from "../support/site-fixture.js";

let server: AuthServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

/** Boots the server and signs in through the fake GitHub. */
async function bootSignedIn(github: FakeGitHubOptions) {
  const hub = fakeGitHub(github);
  server = await startAuthServer({ config: testAuthConfig, fetchImpl: hub.fetch });
  return { site: server, hub, headers: await signedIn(server) };
}

describe("GitHub repo listing", () => {
  test("lists an org's repos with the user's token and caches the page", async () => {
    const { site, hub, headers } = await bootSignedIn({
      orgs: ["Mupt-AI"],
      repos: [
        { full_name: "Mupt-AI/self-bench", private: true, pushed_at: "2026-09-04T00:00:00Z" },
        { full_name: "Mupt-AI/site" },
      ],
    });
    const response = await site.request("/api/orgs/mupt-ai/github-repos", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repos: { fullName: string; private: boolean }[] };
    expect(body.repos.map((repo) => [repo.fullName, repo.private])).toEqual([
      ["Mupt-AI/self-bench", true],
      ["Mupt-AI/site", false],
    ]);
    expect(body.repos[0]).toMatchObject({
      githubId: 5000,
      name: "self-bench",
      defaultBranch: "main",
      language: "TypeScript",
      pushedAt: "2026-09-04T00:00:00Z",
    });
    const listCalls = () => hub.calls.filter((call) => call.includes("/orgs/Mupt-AI/repos"));
    expect(listCalls()).toEqual([
      "GET https://api.github.example/orgs/Mupt-AI/repos?type=all&sort=pushed&per_page=100&page=1",
    ]);
    await site.request("/api/orgs/Mupt-AI/github-repos", { headers });
    expect(listCalls()).toHaveLength(1);
  });

  test("lists the personal tenant from /user/repos and refuses foreign orgs", async () => {
    const { site, hub, headers } = await bootSignedIn({
      orgs: [],
      repos: [{ full_name: "avyay/x" }],
    });
    const mine = await site.request("/api/orgs/avyay/github-repos", { headers });
    expect(mine.status).toBe(200);
    expect(hub.calls.at(-1)).toBe(
      "GET https://api.github.example/user/repos?affiliation=owner,collaborator&sort=pushed&per_page=100&page=1",
    );
    expect((await site.request("/api/orgs/someone-else/github-repos", { headers })).status).toBe(
      404,
    );
    expect((await site.request("/api/orgs/avyay/github-repos")).status).toBe(401);
  });

  test("reports the repo and its merged pull requests over the last year", async () => {
    const { site, hub, headers } = await bootSignedIn({
      orgs: [],
      repos: [{ full_name: "avyay/x" }],
      mergedPullRequests: 37,
    });
    const response = await site.request("/api/github-repos/avyay/x", { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      repo: { fullName: "avyay/x", defaultBranch: "main" },
      mergedPullRequests: 37,
    });
    expect((await site.request("/api/github-repos/avyay/missing", { headers })).status).toBe(404);
    const search = hub.calls.find((call) => call.includes("/search/issues")) ?? "";
    expect(decodeURIComponent(search)).toContain("repo:avyay/x is:pr is:merged merged:>=");
    expect((await site.request("/api/github-repos/bad%20name/x", { headers })).status).toBe(400);
  });
});

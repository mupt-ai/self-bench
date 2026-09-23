import { describe, expect, test } from "bun:test";
import { createOrgGate } from "../src/api/auth/allowed-orgs.js";
import { GitHubIdentityError, type OrgMembership } from "../src/third_party/github/oauth.js";

const member: OrgMembership = {
  githubId: 1,
  login: "mupt-ai",
  role: "member",
};

describe("organization gate", () => {
  test("a successful sign-in refreshes a cached denial", async () => {
    let memberships: OrgMembership[] = [];
    const fetchImpl = (async () => Response.json(memberships)) as unknown as typeof fetch;
    const gate = createOrgGate({
      githubApiUrl: "https://api.github.test",
      allowedOrgs: ["mupt-ai"],
      fetchImpl,
    });

    expect(await gate.permits(42, "token")).toBe(false);
    memberships = [member];
    expect(gate.admits(42, memberships)).toBe(true);
    expect(await gate.permits(42, "token")).toBe(true);
  });

  test("maps membership API failures to identity-unavailable errors", async () => {
    const fetchImpl = (async () => new Response("", { status: 429 })) as unknown as typeof fetch;
    const gate = createOrgGate({
      githubApiUrl: "https://api.github.test",
      allowedOrgs: ["mupt-ai"],
      fetchImpl,
    });

    try {
      await gate.permits(42, "token");
      throw new Error("expected permits to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubIdentityError);
      expect((error as GitHubIdentityError).status).toBe(429);
    }
  });

  test("maps network failures to service unavailable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network unavailable");
    }) as unknown as typeof fetch;
    const gate = createOrgGate({
      githubApiUrl: "https://api.github.test",
      allowedOrgs: ["mupt-ai"],
      fetchImpl,
    });

    await expect(gate.permits(42, "token")).rejects.toMatchObject({ status: 503 });
  });
});

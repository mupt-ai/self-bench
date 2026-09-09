import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { GitHubOAuthError } from "../src/auth/github.js";
import { sendExpiredSession } from "../src/auth/session-expired.js";
import { listMergedPullRequests } from "../src/site/pr-list.js";

test("GitHub 401 clears the session with a readable response; other failures do not", async () => {
  const server = createServer(async (request, response) => {
    const status = Number(request.url?.slice(1));
    try {
      await listMergedPullRequests(
        { githubApiUrl: "https://example.test" },
        "test-token",
        "owner/repo",
        1,
        (async () => new Response("", { status })) as unknown as typeof fetch,
      );
    } catch (error) {
      expect(error).toBeInstanceOf(GitHubOAuthError);
      if (sendExpiredSession(response, error, "https://selfbench.test")) return;
      response.writeHead(502).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  try {
    const expired = await fetch(`http://127.0.0.1:${address.port}/401`);
    expect(expired.status).toBe(401);
    expect(expired.headers.get("set-cookie")).toContain(
      "selfbench_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    );
    expect(await expired.json()).toMatchObject({ code: "session_expired" });
    for (const status of [403, 429, 500]) {
      const response = await fetch(`http://127.0.0.1:${address.port}/${status}`);
      expect(response.status).toBe(502);
      expect(response.headers.get("set-cookie")).toBeNull();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configPath, readConfig } from "../src/api/cli/config.js";
import { runCli } from "../src/api/cli/main.js";
import { signedIn } from "./support/sign-in.js";
import { type AuthServer, fakeGitHub, startAuthServer } from "./support/site-fixture.js";

let server: AuthServer | undefined;
let home = "";
const environment = { ...process.env };
afterEach(async () => {
  await server?.stop();
  server = undefined;
  process.env = { ...environment };
  await rm(home, { recursive: true, force: true });
});

test("login saves a key from the browser approval, commands use it, and logout revokes it", async () => {
  server = await startAuthServer({ fetchImpl: fakeGitHub().fetch });
  const site = server;
  home = await mkdtemp(join(tmpdir(), "selfbench-cli-home-"));
  process.env.XDG_CONFIG_HOME = home;
  delete process.env.SELFBENCH_API_KEY;
  delete process.env.SELFBENCH_API_URL;
  delete process.env.SELFBENCH_ORG;
  const { cookie } = await signedIn(site);

  // The person's browser: opens the printed URL, approves, and follows the redirect to the CLI.
  const errors = spyOn(console, "error").mockImplementation((text: unknown) => {
    const url = /https?:\/\/\S+\/auth\/cli\?\S+/.exec(String(text))?.[0];
    if (!url) return;
    void (async () => {
      const asked = new URL(url);
      const approved = await site.request("/auth/cli", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie },
        body: asked.searchParams.toString(),
      });
      await fetch(approved.headers.get("location") ?? "");
    })();
  });
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli(["login", "--api-url", site.origin, "--no-browser"]);
    const saved = readConfig();
    expect(saved).toMatchObject({ apiUrl: site.origin, login: expect.any(String) });
    expect(saved.apiKey).toStartWith("sbk_");
    expect((await stat(configPath())).mode & 0o077).toBe(0);

    await runCli(["whoami", "--json"]);
    const me = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
    expect(me.auth).toBe("api-key");

    await runCli(["logout"]);
    expect(readConfig()).toEqual({});
    const revoked = await site.request("/api/me", {
      headers: { authorization: `Bearer ${saved.apiKey}` },
    });
    expect(revoked.status).toBe(401);
  } finally {
    errors.mockRestore();
    log.mockRestore();
  }
});

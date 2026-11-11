import { afterEach, expect, spyOn, test } from "bun:test";
import { runCli } from "../src/api/cli/main.js";

process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

/** Runs the CLI against a server that accepts anything, returning the requests it sent. */
async function cli(args: string[]) {
  process.env.SELFBENCH_API_URL = "http://selfbench.test";
  process.env.SELFBENCH_API_KEY = "sbk_test";
  const sent: string[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    sent.push(
      `${init?.method ?? "GET"} ${new URL(String(input)).pathname}${init?.body ? ` ${init.body}` : ""}`,
    );
    return Response.json({});
  }) as typeof fetch);
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli([...args, "--json"]);
    return sent;
  } finally {
    log.mockRestore();
    fetchSpy.mockRestore();
  }
}

test("workspace and member commands reach the workspace routes", async () => {
  expect(await cli(["workspace", "create", "acme-evals", "--name", "Acme Evals"])).toEqual([
    'POST /api/orgs {"login":"acme-evals","name":"Acme Evals"}',
  ]);
  expect(await cli(["workspace", "connect", "acme", "--org", "acme-evals"])).toEqual([
    'POST /api/orgs/acme-evals/github {"login":"acme"}',
  ]);
  expect(await cli(["member", "invite", "grace", "--role", "admin", "--org", "acme"])).toEqual([
    'POST /api/orgs/acme/invites {"login":"grace","role":"admin"}',
  ]);
  expect(await cli(["member", "role", "grace", "member", "--org", "acme"])).toEqual([
    'POST /api/orgs/acme/members/grace/role {"role":"member"}',
  ]);
  expect(await cli(["member", "revoke", "7", "--org", "acme"])).toEqual([
    "POST /api/orgs/acme/invites/7/delete {}",
  ]);
  await expect(
    cli(["member", "invite", "grace", "--role", "owner", "--org", "acme"]),
  ).rejects.toThrow("--role must be admin or member");
});

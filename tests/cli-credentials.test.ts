import { afterEach, expect, spyOn, test } from "bun:test";
import { runCli } from "../src/api/cli/main.js";

process.env.XDG_CONFIG_HOME = "/nonexistent/selfbench-test-config";
const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

/** Runs the CLI against canned replies, returning the requests it sent. */
async function cli(args: string[], replies: Record<string, unknown>) {
  process.env.SELFBENCH_API_URL = "http://selfbench.test";
  process.env.SELFBENCH_API_KEY = "sbk_test";
  const sent: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    sent.push({
      method,
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    const reply = replies[`${method} ${url.pathname}`];
    return reply === undefined
      ? Response.json({ error: "unexpected" }, { status: 404 })
      : Response.json(reply);
  }) as typeof fetch);
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli(args);
    return sent;
  } finally {
    log.mockRestore();
    fetchSpy.mockRestore();
  }
}

const base = "/api/orgs/acme/credentials";

test("credential add takes the secret from an environment variable, never an argument", async () => {
  process.env.MODAL_SECRET = "as-secret";
  const sent = await cli(
    [
      "credential",
      "add",
      "--org",
      "acme",
      "--kind",
      "modal",
      "--token-id",
      "ak-1",
      "--value-env",
      "MODAL_SECRET",
    ],
    { [`POST ${base}`]: { id: "c1", name: "Modal" } },
  );
  expect(sent.at(-1)).toEqual({
    method: "POST",
    path: base,
    body: { name: "Modal", kind: "modal", auth: "api-key", value: "as-secret", tokenId: "ak-1" },
  });
  await expect(
    cli(
      ["credential", "add", "--org", "acme", "--kind", "modal", "--value-env", "MODAL_SECRET"],
      {},
    ),
  ).rejects.toThrow("--token-id");
  await expect(cli(["credential", "add", "--org", "acme", "--kind", "openai"], {})).rejects.toThrow(
    "--value-env",
  );
});

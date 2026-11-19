import { spyOn } from "bun:test";
import { runCli } from "../../src/api/cli/main.js";

export interface Sent {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * Runs the CLI against canned replies keyed `METHOD path?query`, returning the requests it sent and
 * the JSON it printed last. A request with no canned reply gets a 404.
 */
export async function cannedCli(args: string[], replies: Record<string, unknown>) {
  process.env.SELFBENCH_API_URL = "http://selfbench.test";
  process.env.SELFBENCH_API_KEY = "sbk_test";
  const sent: Sent[] = [];
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = `${url.pathname}${url.search}`;
    sent.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const reply = replies[`${method} ${path}`];
    return reply === undefined
      ? Response.json({ error: `unexpected ${method} ${path}` }, { status: 404 })
      : Response.json(reply);
  }) as typeof fetch);
  const log = spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await runCli([...args, "--json"]);
    return { sent, printed: JSON.parse(String(log.mock.calls.at(-1)?.[0])) };
  } finally {
    log.mockRestore();
    fetchSpy.mockRestore();
  }
}

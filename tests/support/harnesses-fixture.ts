import { evaluationServer } from "./evaluation-fixture.js";

export const HARNESSES = "/api/orgs/avyay/harnesses";
export const send = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/**
 * An evaluation server with a gateway key and a sandbox key, and requests that save a harness
 * and start a comparison. The caller closes `server`.
 */
export async function harnessesWorkspace() {
  const server = await evaluationServer();
  const credential = async (kind: string, name = kind) => {
    const response = await server.request(
      "/api/orgs/avyay/credentials",
      send("POST", { kind, name, value: `fake-${name}` }),
    );
    return (await response.json()).id as string;
  };
  const router = await credential("openrouter");
  const sandbox = await credential("e2b");
  const save = async (harness: unknown) => {
    const response = await server.request(HARNESSES, send("POST", harness));
    return { status: response.status, ...(await response.json()) };
  };
  const row = (catalogId: string, harness: string): Record<string, unknown> => ({
    catalogId,
    credentialId: router,
    harnesses: [harness],
    thinking: "high",
  });
  /** Starts a comparison, returning the runs it started or why it was refused. */
  const compare = async (body: {
    models: unknown[];
    harnesses?: number[];
    environments?: number[];
    conditions?: unknown[];
    baseline?: false;
  }) => {
    const before = server.starts.length;
    const response = await server.request(
      `${server.base}/comparisons`,
      send("POST", {
        id: crypto.randomUUID(),
        tasks: [{ runId: "run-one", taskId: "task-one" }],
        sandbox: "e2b",
        sandboxCredentialId: sandbox,
        ...body,
      }),
    );
    const reply = await response.json();
    return { error: reply.error as string | undefined, started: server.starts.slice(before) };
  };
  return { server, router, sandbox, credential, save, row, compare };
}

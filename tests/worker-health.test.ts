import { expect, test } from "bun:test";
import type { AddressInfo } from "node:net";
import { createWorkerHealthServer } from "../src/temporal/worker-health.js";

test("worker readiness follows its lifecycle without depending on queue polling", async () => {
  let state = "INITIALIZED";
  const server = createWorkerHealthServer(() => state);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    expect((await fetch(`${origin}/healthz`)).status).toBe(503);
    state = "RUNNING";
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/unknown`)).status).toBe(404);
    state = "STOPPING";
    expect((await fetch(`${origin}/healthz`)).status).toBe(503);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

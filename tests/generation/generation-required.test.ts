import { expect, test } from "bun:test";
import { GENERATION_REQUIRED } from "../../src/generation/settings/credentials.js";
import { fixture, ROOT } from "../support/batch-fixture.js";
import { memoryVault } from "../support/evaluation-vault.js";
import { prFixture, pullRequest, REPO } from "../support/pr-fixture.js";

// Without settings a run would fall back to the worker's own sandbox backend and credentials.
test("a site that stores credentials refuses a PR run without generation settings", async () => {
  const { site, headers, started } = await prFixture({
    vault: memoryVault(),
    pullRequests: { 57: pullRequest(57) },
  });
  try {
    const response = await site.request(`${REPO}/tasks/from-pr`, {
      method: "POST",
      headers,
      body: JSON.stringify({ pr: 57 }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(GENERATION_REQUIRED);
    expect(started).toHaveLength(0);
  } finally {
    await site.stop();
  }
});

test("a site that stores credentials refuses a batch without generation settings", async () => {
  const f = await fixture({ vault: memoryVault() });
  const response = await f.start();
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe(GENERATION_REQUIRED);
  expect(f.started).toHaveLength(0);
  expect((await f.request(ROOT)).status).toBe(200);
});

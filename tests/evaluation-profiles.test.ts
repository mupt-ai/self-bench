import { afterAll, beforeAll, expect, test } from "bun:test";
import { solverEnvironment } from "../src/evaluation/config.js";
import { profileEnvironment, readSetup, saveSetup } from "../src/evaluation/profiles.js";
import { providerIds, providers } from "../src/evaluation/providers.js";
import { evaluationEnv, evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";

let server: Awaited<ReturnType<typeof evaluationServer>>;
beforeAll(async () => {
  server = await evaluationServer();
});
afterAll(async () => {
  await server.close();
});
const setup = {
  provider: "openai" as const,
  model: "test-model",
  modelApiKey: "secret-model-never-show",
  sandbox: "e2b" as const,
  sandboxApiKey: "secret-sandbox-never-show",
  pricing: {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 1.2,
    source: "https://example.test/pricing",
    asOf: "2026-09-05",
  },
};
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });

test("saving a setup is scoped, encrypted, and never starts a model or exposes keys", async () => {
  expect((await server.request(`${server.base}/profiles`, post(setup), null)).status).toBe(401);
  expect((await server.request(`${server.base}/profiles`, post(setup), 2)).status).toBe(404);
  expect(
    (
      await server.request(`${server.base}/profiles`, {
        ...post(setup),
        headers: { origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
  const response = await server.request(`${server.base}/profiles`, post(setup));
  expect(response.status).toBe(201);
  const profile = await response.json();
  expect(profile.sandbox).toBe("e2b");
  expect(JSON.stringify(profile)).not.toContain("secret-");
  const entries = await server.artifacts.list("private/evaluation-profiles");
  expect(entries).toHaveLength(1);
  const entry = entries[0];
  if (!entry) throw new Error("Encrypted profile missing");
  const bytes = await server.artifacts.getByKey(entry.key);
  if (!bytes) throw new Error("Encrypted profile missing");
  expect(Buffer.from(bytes).toString()).not.toContain(setup.modelApiKey);
  expect(
    await readSetup(server.artifacts, server.repo.id, 2, profile.id, evaluationEnv),
  ).toBeUndefined();
  expect(
    await readSetup(server.artifacts, server.repo.id + 1, 1, profile.id, evaluationEnv),
  ).toBeUndefined();
  const options = await (await server.request(`${server.base}/options`)).text();
  expect(options).toContain(profile.id);
  expect(options).not.toContain(setup.modelApiKey);
  expect(options).not.toContain(setup.sandboxApiKey);
  expect(server.starts).toHaveLength(0);
});
test("setup validation requires sandbox credentials and never echoes submitted values", async () => {
  for (const invalid of [
    { ...setup, sandboxApiKey: undefined },
    { ...setup, model: "--command" },
    { ...setup, sandbox: "modal" },
    { ...setup, endpoint: "http://internal" },
  ]) {
    const response = await server.request(`${server.base}/profiles`, post(invalid));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(setup.modelApiKey);
  }
});
test("saved setup starts with a credential reference only; worker gets selected keys only", async () => {
  const profile = await saveSetup(
    server.artifacts,
    server.repo.id,
    1,
    "avyay",
    setup,
    evaluationEnv,
  );
  const selection = {
    id: crypto.randomUUID(),
    model: profile.id,
    sandbox: "e2b",
    harnesses: ["codex"],
    tasks: [{ runId: "run-one", taskId: "task-one" }],
  };
  expect(
    (await server.request(server.base, post({ ...selection, sandbox: "docker" }))).status,
  ).toBe(400);
  expect((await server.request(server.base, post(selection))).status).toBe(202);
  const input = server.starts.at(-1);
  if (!input) throw new Error("Run missing");
  expect(input.credentialOwnerId).toBe(1);
  expect(input.pricing).toEqual(setup.pricing);
  expect(JSON.stringify(input)).not.toContain("secret-");
  const resolved = await profileEnvironment(server.artifacts, input, {
    ...evaluationEnv,
    PATH: "/usr/bin",
    GH_TOKEN: "github-secret",
    E2B_API_KEY: "host-sandbox-key",
  });
  const { child } = solverEnvironment(input, "/isolated", resolved);
  expect(child.OPENAI_API_KEY).toBe(setup.modelApiKey);
  expect(child.E2B_API_KEY).toBe(setup.sandboxApiKey);
  expect(child.GH_TOKEN).toBeUndefined();
  expect(child.SELFBENCH_EVAL_CREDENTIAL_KEY).toBeUndefined();
  expect(child.ANTHROPIC_API_KEY).toBeUndefined();
  const request = await server.artifacts.getByKey(
    `evaluations/repos/${server.repo.id}/${selection.id}/request.json`,
  );
  if (!request) throw new Error("Request missing");
  expect(Buffer.from(request).toString()).not.toContain("secret-");
  await expect(
    profileEnvironment(server.artifacts, { ...input, credentialOwnerId: 2 }, evaluationEnv),
  ).rejects.toThrow("unavailable");
  await expect(
    profileEnvironment(server.artifacts, input, {
      ...evaluationEnv,
      SELFBENCH_EVAL_CREDENTIAL_KEY: "b".repeat(64),
    }),
  ).rejects.toThrow();
});
test("Modal and Daytona pass only their own sandbox credentials", async () => {
  for (const sandbox of ["modal", "daytona", "docker"] as const) {
    const configured = {
      ...setup,
      sandbox,
      sandboxApiKey: sandbox === "daytona" ? "daytona-secret" : undefined,
      modalTokenId: sandbox === "modal" ? "modal-id" : undefined,
      modalTokenSecret: sandbox === "modal" ? "modal-secret" : undefined,
    };
    const profile = await saveSetup(server.artifacts, 1, 1, "avyay", configured, evaluationEnv);
    const input = { ...evaluationInput(), model: profile.id, credentialOwnerId: 1, sandbox };
    const { child } = solverEnvironment(
      input,
      "/isolated",
      await profileEnvironment(server.artifacts, input, evaluationEnv),
    );
    expect(child.E2B_API_KEY).toBeUndefined();
    expect(child.MODAL_TOKEN_SECRET).toBe(configured.modalTokenSecret);
    expect(child.DAYTONA_API_KEY).toBe(configured.sandboxApiKey);
  }
});

test("every supported provider forwards only its own key with compatible harnesses", async () => {
  for (const provider of providerIds) {
    const configured = {
      ...setup,
      provider,
      model: provider === "openrouter" ? "anthropic/claude-test" : "test-model",
      sandbox: "docker" as const,
      sandboxApiKey: undefined,
    };
    const profile = await saveSetup(server.artifacts, 1, 1, "avyay", configured, evaluationEnv);
    expect(profile.harnesses).toEqual(providers[provider].harnesses);
    const input = {
      ...evaluationInput(),
      model: profile.id,
      modelName: profile.model,
      harnesses: ["pi" as const],
      credentialOwnerId: 1,
    };
    const host = {
      ...evaluationEnv,
      ...Object.fromEntries(
        providerIds.map((id) => [providers[id].credential, "unrelated-host-key"]),
      ),
    };
    const { child } = solverEnvironment(
      input,
      "/isolated",
      await profileEnvironment(server.artifacts, input, host),
    );
    for (const candidate of providerIds)
      expect(child[providers[candidate].credential]).toBe(
        candidate === provider ? setup.modelApiKey : undefined,
      );
  }
});

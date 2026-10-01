import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialExecution } from "../src/evaluation/execution.js";
import { codexAccess, codexAuth } from "./support/codex-auth.js";
import { evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";
import { clearMockModels, mockReferenceModelsAsListed } from "./support/model-catalog.js";

beforeEach(mockReferenceModelsAsListed);
afterEach(clearMockModels);
const credentialsUrl = "/api/orgs/avyay/credentials";
const post = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

test("ChatGPT sign-in supplies each harness its own isolated auth for GPT-6.1 Sol", async () => {
  const records = memoryVault();
  const fixture = await evaluationServer(records);
  const home = await mkdtemp(join(tmpdir(), "codex-auth-fixture-"));
  try {
    const model = await (
      await fixture.request(
        credentialsUrl,
        post({ name: "Codex", kind: "openai", auth: "codex-login", value: codexAuth }),
      )
    ).json();
    const sandbox = await (
      await fixture.request(
        credentialsUrl,
        post({ name: "Sandbox", kind: "e2b", value: "fake-sandbox" }),
      )
    ).json();
    const draft = {
      id: crypto.randomUUID(),
      tasks: [{ runId: "run-one", taskId: "task-one" }],
      models: [{ catalogId: "gpt-6.1-sol", credentialId: model.id, harnesses: ["pi"] }],
      sandbox: "e2b",
      sandboxCredentialId: sandbox.id,
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const input = fixture.starts[0];
    if (!input) throw new Error("Missing input");
    expect(input.pricing).toMatchObject({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 });
    // The sign-in type rides with the run so its cost can account for unreported cache writes.
    expect(input.credentials?.auth).toBe("codex-login");
    const execution = await credentialExecution(
      input,
      home,
      { OPENAI_API_KEY: "do-not-use" },
      records,
    );
    expect(execution.child.OPENAI_API_KEY).toBeUndefined();
    expect(execution.child.CODEX_AUTH_JSON_PATH).toBeUndefined();
    expect(
      JSON.parse(await readFile(execution.child.SELFBENCH_PI_AUTH_JSON_PATH ?? "", "utf8")),
    ).toEqual({
      "openai-codex": {
        type: "oauth",
        access: codexAccess,
        refresh: "test-refresh",
        expires: 2000000000000,
        accountId: "test-account",
      },
    });
    expect(execution.secrets).toContain("test-refresh");
    expect(execution.auth).toBe("codex-login");
    draft.id = crypto.randomUUID();
    draft.models[0] = { catalogId: "gpt-6.1-sol", credentialId: model.id, harnesses: ["codex"] };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const codexInput = fixture.starts[1];
    if (!codexInput) throw new Error("Missing Codex input");
    const codex = await credentialExecution(codexInput, home, {}, records);
    expect(await readFile(codex.child.CODEX_AUTH_JSON_PATH ?? "", "utf8")).toBe(codexAuth);
    expect(codex.child.SELFBENCH_PI_AUTH_JSON_PATH).toBeUndefined();
    expect(codex.child.CHATGPT_TOKEN_DIR).toBeUndefined();
    draft.id = crypto.randomUUID();
    draft.models[0] = {
      catalogId: "gpt-6.1-sol",
      credentialId: model.id,
      harnesses: ["mini-swe-agent", "terminus-2"],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const litellmInput = fixture.starts[2];
    if (!litellmInput) throw new Error("Missing LiteLLM input");
    const litellm = await credentialExecution(litellmInput, home, {}, records);
    expect(litellm.child.CHATGPT_TOKEN_DIR).toBe(join(home, "chatgpt"));
    expect(litellm.child.SELFBENCH_CHATGPT_AUTH_JSON_PATH).toBe(join(home, "chatgpt", "auth.json"));
    expect(JSON.parse(await readFile(join(home, "chatgpt", "auth.json"), "utf8"))).toEqual({
      access_token: codexAccess,
      refresh_token: "test-refresh",
      expires_at: 2000000000,
      account_id: "test-account",
    });
    expect(litellm.child.CODEX_AUTH_JSON_PATH).toBeUndefined();
    expect(litellm.child.SELFBENCH_PI_AUTH_JSON_PATH).toBeUndefined();
    draft.id = crypto.randomUUID();
    draft.models[0] = {
      catalogId: "gpt-6.1-sol",
      credentialId: model.id,
      harnesses: ["claude-code"],
    };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(400);
    // A sign-in Pi or LiteLLM cannot read fails the trial at once instead of retrying.
    const opaque = await (
      await fixture.request(
        credentialsUrl,
        post({
          name: "Opaque",
          kind: "openai",
          auth: "codex-login",
          value: JSON.stringify({ tokens: { access_token: "opaque", refresh_token: "refresh" } }),
        }),
      )
    ).json();
    draft.id = crypto.randomUUID();
    draft.models[0] = { catalogId: "gpt-6.1-sol", credentialId: opaque.id, harnesses: ["pi"] };
    expect((await fixture.request(`${fixture.base}/comparisons`, post(draft))).status).toBe(202);
    const unreadable = fixture.starts[3];
    if (!unreadable) throw new Error("Missing unreadable input");
    await expect(credentialExecution(unreadable, home, {}, records)).rejects.toMatchObject({
      type: "TrialRefused",
      nonRetryable: true,
      message: "ChatGPT sign-in is invalid. Reconnect it in Credentials.",
    });
  } finally {
    await fixture.close();
    await rm(home, { recursive: true, force: true });
  }
});

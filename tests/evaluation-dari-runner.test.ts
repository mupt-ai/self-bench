import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DARI_BILLING } from "../src/evaluation/dari/billing.js";
import { scopeOf } from "../src/evaluation/scope.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import type { runCommand } from "../src/lib/process.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

test("Dari runner persists response prices without transcript or telemetry lookup", async () => {
  const { store, input, vault } = await runnerFixture();
  const credential = await vault.credentials.create(
    1,
    {
      name: "Dari",
      kind: "custom",
      auth: "api-key",
      endpoint: "https://routing.dari.dev/v1",
      value: "dari-test-key",
    },
    { SELFBENCH_CUSTOM_MODEL_HOSTS: "routing.dari.dev" },
  );
  input.id = crypto.randomUUID();
  input.modelName = "openai/dari/routing";
  input.harnesses = ["pi"];
  if (!input.credentials) throw new Error("Fixture credentials missing");
  input.credentials.provider = "custom";
  input.credentials.modelCredentialId = credential.id;
  input.comparisonId = crypto.randomUUID();
  await vault.comparisons.insert({
    id: input.comparisonId,
    orgId: 1,
    scope: scopeOf(input),
    createdAt: input.createdAt,
    signature: "dari",
    inputs: [input],
  });
  await saveEvaluation(store, initialEvaluation(input, "Dari Router"));
  const id = "35fcb4c6-5902-40a7-adfe-e9289cab6855";
  const command: typeof runCommand = async (_name, args) => {
    if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
    const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver", "task__123");
    await mkdir(join(trial, "agent"), { recursive: true });
    const reply = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        provider: "harbor-endpoint",
        model: "dari/routing",
        responseId: `chatcmpl-${id}`,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        stopReason: "stop",
        content: [{ type: "text", text: "x".repeat(1024 * 1024) }],
      },
    });
    // Real Pi streams can exceed wholeTranscripts' 32 MiB ceiling, particularly when
    // repeated tool output and streaming updates dwarf the accounting events.
    const delta = JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { delta: "x".repeat(33 * 1024 * 1024) },
    });
    await writeFile(join(trial, "agent", "pi.txt"), `${reply}\n${delta}\n`);
    await writeFile(
      join(trial, "agent", "dari-billing.jsonl"),
      `${JSON.stringify({ type: "request", index: 1 })}\n${JSON.stringify({ type: "cost", index: 1, requestId: id, cost: 0.15 })}\n`,
    );
    await writeFile(
      join(trial, "result.json"),
      JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
    );
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("Response pricing must not query telemetry");
  }) as unknown as typeof fetch;
  try {
    await runEvaluation(store, input, {
      env: { SELFBENCH_CUSTOM_MODEL_HOSTS: "routing.dari.dev" },
      vault,
      command,
    });
  } finally {
    globalThis.fetch = original;
  }
  const run = await getEvaluation(store, input, input.id);
  expect(run?.trials[0]).toMatchObject({
    status: "completed",
    modelVerified: true,
    apiCostUsd: 0.15,
    costSource: "router-reference-rates",
  });
  const artifact = run?.trials[0]?.artifacts.find((name) => name.endsWith(DARI_BILLING));
  expect(artifact).toBeDefined();
  const bytes = await store.getByKey(`${evaluationPrefix(input, input.id)}artifacts/${artifact}`);
  if (!bytes) throw new Error("Manifest artifact missing");
  expect(Buffer.from(bytes).toString()).toContain('"cost":0.15');
});

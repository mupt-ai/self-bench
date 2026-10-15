import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DARI_BILLING } from "../src/evaluation/dari/billing.js";
import { scopeOf } from "../src/evaluation/scope.js";
import {
  evaluationPrefix,
  getEvaluation,
  initialEvaluation,
  saveEvaluation,
} from "../src/evaluation/store.js";
import { HARBOR_VERSION } from "../src/harnesses/harbor/command.js";
import { runCommand } from "../src/lib/process.js";
import { runEvaluation } from "./support/evaluation-run.js";
import { runnerFixture } from "./support/evaluation-runner-fixture.js";

// Real Pi CLI, response capture extension and evaluation persistence; only the model server
// and sandbox process boundary are test fixtures. No paid inference or sandbox calls.
test("Pi error/retry saves both returned prices in the completed evaluation", async () => {
  const { root, input, store, vault } = await runnerFixture();
  let requests = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      const body = await request.json();
      expect(body.model).toBe("dari/routing");
      const failed = ++requests === 1;
      const id = crypto.randomUUID();
      const frame = {
        id: `chatcmpl-${id}`,
        model: "dari/routing",
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: { content: failed ? "partial" : "OK" },
            finish_reason: failed ? "error" : "stop",
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 1,
          total_tokens: 3,
          cost: failed ? 0.02 : 0.03,
        },
        ...(failed
          ? { error: { message: "503: retryable failure", code: "provider_execution_failed" } }
          : {}),
      };
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "x-request-id": id },
      });
    },
  });
  const credential = await vault.credentials.create(
    1,
    {
      name: "Dari",
      kind: "custom",
      auth: "api-key",
      endpoint: "https://routing.dari.dev/v1",
      value: "local-test-key",
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
    signature: "local-dari-response-test",
    inputs: [input],
  });
  await saveEvaluation(store, initialEvaluation(input, "Dari Router"));
  const agent = join(root, "pi-agent");
  await mkdir(agent);
  await writeFile(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        "harbor-endpoint": {
          baseUrl: "https://routing.dari.dev/v1",
          apiKey: "local-test-key",
          api: "openai-completions",
          models: [{ id: "dari/routing" }],
        },
      },
    }),
  );
  await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { baseDelayMs: 1 } }));
  const transport = join(root, "transport.cjs");
  // Rewrite transport in tests only; production capture still validates the Dari HTTPS host.
  await writeFile(
    transport,
    `module.exports=pi=>pi.on('session_start',()=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.origin==='https://routing.dari.dev'){u.host='127.0.0.1:${server.port}';u.protocol='http:';return original(u,init)}return original(input,init)};});`,
  );
  try {
    await runEvaluation(store, input, {
      vault,
      env: { SELFBENCH_CUSTOM_MODEL_HOSTS: "routing.dari.dev" },
      command: async (_name, args) => {
        if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
        expect(args[args.indexOf("--agent") + 1]).toBe("harbor_dari:DariPi");
        const trial = join(args[args.indexOf("--jobs-dir") + 1] ?? "", "solver/task");
        await mkdir(join(trial, "agent"), { recursive: true });
        const result = await runCommand(
          "node",
          [
            resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
            "--extension",
            transport,
            "--extension",
            resolve("src/evaluation/dari/capture.cjs"),
            "--provider",
            "harbor-endpoint",
            "--model",
            "dari/routing",
            "--print",
            "--mode",
            "json",
            "--no-tools",
            "--no-extensions",
            "--no-skills",
            "--no-context-files",
            "--no-session",
            "--offline",
            "Say OK",
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PI_CODING_AGENT_DIR: agent,
              SELFBENCH_DARI_BILLING_PATH: join(trial, "agent/dari-billing.jsonl"),
            },
            timeoutMs: 30_000,
          },
        );
        await writeFile(join(trial, "agent/pi.txt"), result.stdout);
        await writeFile(
          join(trial, "result.json"),
          JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
        );
        return result;
      },
    });
    const run = await getEvaluation(store, input, input.id);
    expect(requests).toBe(2);
    expect(run?.trials[0]).toMatchObject({
      status: "completed",
      apiCostUsd: 0.05,
      modelVerified: true,
      costSource: "router-reference-rates",
    });
    const artifact = run?.trials[0]?.artifacts.find((name) => name.endsWith(DARI_BILLING));
    expect(artifact).toBeDefined();
    const bytes = await store.getByKey(`${evaluationPrefix(input, input.id)}artifacts/${artifact}`);
    expect(Buffer.from(bytes ?? []).toString()).toContain('"cost":0.02');
    expect(Buffer.from(bytes ?? []).toString()).toContain('"cost":0.03');
  } finally {
    server.stop(true);
  }
}, 40_000);

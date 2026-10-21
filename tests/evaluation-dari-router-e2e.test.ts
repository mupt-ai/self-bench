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

const ROUTER = "https://routing.dari.dev/rtr_e2e0c8cbf46cab1b325ec0";

// A Dari credential that names a router, carried through the real runner, Harbor agent choice,
// Pi CLI and response capture; only the model server and sandbox boundary are fixtures.
test("a Dari credential's router reaches the request and its returned price", async () => {
  const { root, input, store, vault } = await runnerFixture();
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      paths.push(new URL(request.url).pathname);
      const body = await request.json();
      expect(body.model).toBe("dari/routing");
      const id = crypto.randomUUID();
      const frame = {
        id: `chatcmpl-${id}`,
        model: "dari/routing",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.04 },
      };
      // The router ids every response; capture records it beside the returned price.
      return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream", "x-request-id": id },
      });
    },
  });
  // The router is pasted as the request address Dari shows, API method and all.
  const credential = await vault.credentials.create(
    1,
    {
      name: "Dari Jev Router",
      kind: "dari",
      auth: "api-key",
      endpoint: `${ROUTER}/chat/completions`,
      value: "local-test-key",
    },
    {},
  );
  expect(credential.endpoint).toBe(ROUTER);
  input.id = crypto.randomUUID();
  input.modelName = "dari/routing";
  input.harnesses = ["pi"];
  if (!input.credentials) throw new Error("Fixture credentials missing");
  input.credentials.provider = "dari";
  input.credentials.modelCredentialId = credential.id;
  input.comparisonId = crypto.randomUUID();
  await vault.comparisons.insert({
    id: input.comparisonId,
    orgId: 1,
    scope: scopeOf(input),
    createdAt: input.createdAt,
    signature: "local-dari-router-test",
    inputs: [input],
  });
  await saveEvaluation(store, initialEvaluation(input, "Dari Router"));
  const agent = join(root, "pi-agent");
  await mkdir(agent);
  await writeFile(join(agent, "settings.json"), JSON.stringify({}));
  const transport = join(root, "transport.cjs");
  // Rewrite transport in tests only; production capture still validates the Dari HTTPS host.
  await writeFile(
    transport,
    `module.exports=pi=>pi.on('session_start',()=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const u=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(u.origin==='https://routing.dari.dev'){u.host='127.0.0.1:${server.port}';u.protocol='http:';return original(u,init)}return original(input,init)};});`,
  );
  try {
    await runEvaluation(store, input, {
      vault,
      env: { ...process.env },
      command: async (_name, args, options) => {
        if (args[0] === "--version") return { stdout: HARBOR_VERSION, stderr: "", exitCode: 0 };
        expect(args[args.indexOf("--agent") + 1]).toBe("harbor_dari:DariPi");
        // The trial's own environment carries the router, which Pi's model config reads.
        expect(options?.env?.OPENAI_BASE_URL).toBe(ROUTER);
        await writeFile(
          join(agent, "models.json"),
          JSON.stringify({
            providers: {
              "harbor-endpoint": {
                baseUrl: options?.env?.OPENAI_BASE_URL,
                apiKey: "local-test-key",
                api: "openai-completions",
                models: [{ id: "dari/routing" }],
              },
            },
          }),
        );
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
    expect(paths).toEqual(["/rtr_e2e0c8cbf46cab1b325ec0/chat/completions"]);
    expect(run?.trials[0]).toMatchObject({
      status: "completed",
      apiCostUsd: 0.04,
      modelVerified: true,
      costSource: "router-reference-rates",
    });
    expect(run?.modelLabel).toBe("Dari Router");
    const artifact = run?.trials[0]?.artifacts.find((name) => name.endsWith(DARI_BILLING));
    const bytes = await store.getByKey(`${evaluationPrefix(input, input.id)}artifacts/${artifact}`);
    expect(Buffer.from(bytes ?? []).toString()).toContain('"cost":0.04');
  } finally {
    server.stop(true);
  }
}, 40_000);

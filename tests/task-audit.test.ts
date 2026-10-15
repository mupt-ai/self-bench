import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../src/artifacts/local.js";
import { initialEvaluation, saveEvaluation } from "../src/evaluation/store.js";
import { auditTask, readTaskAudit, taskAttempts, verdictOf } from "../src/evaluation/task-audit.js";
import type { EvaluationRun } from "../src/evaluation/types.js";
import type { CommandOptions } from "../src/lib/process.js";
import { evaluationEnv, evaluationInput, evaluationServer } from "./support/evaluation-fixture.js";
import { memoryVault } from "./support/evaluation-vault.js";

test("an audit's verdict line is read off, and a reply without one is Unclear", () => {
  expect(verdictOf("Verdict: Unfair\nThe tests check a log format the instruction omits.")).toEqual(
    {
      verdict: "unfair",
      text: "The tests check a log format the instruction omits.",
    },
  );
  expect(verdictOf("verdict: fair. Both failures broke the parser.")).toEqual({
    verdict: "fair",
    text: "Both failures broke the parser.",
  });
  expect(verdictOf("It depends.")).toEqual({ verdict: "unclear", text: "It depends." });
});

test("a task's attempts are its scored trials across evaluations, oldest first", () => {
  const run = (id: string, createdAt: string, trials: Partial<EvaluationRun["trials"][number]>[]) =>
    ({
      id,
      createdAt,
      trials: trials.map((trial) => ({
        runId: "batch",
        taskId: "task",
        status: "completed",
        rewards: { reward: 0 },
        ...trial,
      })),
    }) as unknown as EvaluationRun;
  const attempts = taskAttempts(
    [
      run("new", "2026-10-02", [{}, { taskId: "other" }]),
      run("old", "2026-10-01", [
        { rewards: { reward: 1 } },
        { status: "failed" },
        { modelVerified: false },
      ]),
    ],
    { runId: "batch", taskId: "task" },
  );
  expect(attempts.map(({ run, index }) => `${run.id}/${index}`)).toEqual(["old/0", "new/0"]);
});

test("Audit Task needs a failed attempt and the task's files, and starts with a saved key", async () => {
  const vault = memoryVault();
  const fixture = await evaluationServer(
    vault,
    {},
    { ...evaluationEnv, SELFBENCH_MANAGED_OFFERING: "false" },
  );
  try {
    const input = { ...evaluationInput(), repoId: fixture.repo.id };
    const run = initialEvaluation(input, input.modelName);
    Object.assign(run.trials[0] ?? {}, { status: "completed", rewards: { reward: 1 } });
    await saveEvaluation(fixture.artifacts, run);
    const task = { runId: "run-one", taskId: "task-one" };
    const state = async () =>
      (await fixture.request(`${fixture.base}/audit?${new URLSearchParams(task)}`)).json();
    const own = await vault.credentials.create(
      fixture.repo.orgId,
      { name: "openai", kind: "openai", auth: "api-key", value: "sk-test-own-key" },
      {},
    );
    const post = (audit?: unknown) =>
      fixture.request(`${fixture.base}/audit`, {
        method: "POST",
        body: JSON.stringify({ ...task, ...(audit ? { audit } : {}) }),
      });
    expect(await state()).toMatchObject({ available: false, attempts: 1, failures: 0 });
    expect((await post({ credentialId: own.id, model: "gpt-6-sol" })).status).toBe(409);

    Object.assign(run.trials[0] ?? {}, { rewards: { reward: 0 } });
    run.revision += 1;
    await saveEvaluation(fixture.artifacts, run);
    expect(await state()).toEqual({ available: true, running: false, attempts: 1, failures: 1 });
    // No frozen bundle and no kept files: nothing to judge the task by.
    expect((await post({ credentialId: own.id, model: "gpt-6-sol" })).status).toBe(409);

    await fixture.artifacts.put(
      `evaluations/repos/${fixture.repo.id}/${run.id}/tasks/0.json`,
      Buffer.from(JSON.stringify({ taskId: "task-one", files: [] })),
      "application/json",
    );
    expect((await post()).status).toBe(400);
    expect((await post({ credentialId: own.id, model: "not-a-catalog-model" })).status).toBe(400);
    expect((await post({ credentialId: own.id, model: "gpt-6-sol" })).status).toBe(202);
    expect(fixture.audits).toEqual([
      {
        repoId: fixture.repo.id,
        ...task,
        filesKey: `evaluations/repos/${fixture.repo.id}/${run.id}/tasks/0.json`,
        audit: { orgId: fixture.repo.orgId, credentialId: own.id, model: "gpt-6-sol" },
      },
    ]);
    expect(JSON.stringify(fixture.audits)).not.toContain("sk-test-own-key");
  } finally {
    await fixture.close();
  }
});

test("an audit keeps the model's verdict, or why the model gave none, through the saved key", async () => {
  const store = new LocalArtifactStore(await mkdtemp(join(tmpdir(), "selfbench-audit-")));
  const input = evaluationInput();
  const run = initialEvaluation(input, "GPT-6 Sol");
  Object.assign(run.trials[0] ?? {}, { status: "completed", rewards: { reward: 0 } });
  await saveEvaluation(store, run);
  const filesKey = "tasks/files.json";
  await store.put(
    filesKey,
    Buffer.from(
      JSON.stringify({
        taskId: "task-one",
        files: [{ path: "instruction.md", sizeBytes: 22, text: "Keep trailing commas." }],
      }),
    ),
    "application/json",
  );
  const vault = { ...memoryVault(), repoOrg: async () => 7 };
  const key = "byok-audit-provider-secret";
  const credential = await vault.credentials.create(
    7,
    { name: "My Key", kind: "openai", auth: "api-key", value: key },
    {},
  );
  const task = { repoId: input.repoId, runId: "run-one", taskId: "task-one" };
  const request = {
    ...task,
    filesKey,
    audit: { orgId: 7, credentialId: credential.id, model: "gpt-6-sol" },
  };
  let reply = { exitCode: 0, stdout: "Verdict: Unfair\nThe tests want a format.", stderr: "" };
  const prompts: string[] = [];
  const command = async (_name: string, args: readonly string[], options?: CommandOptions) => {
    expect(options?.env?.OPENAI_API_KEY).toBe(key);
    prompts.push(args.join(" "));
    return reply;
  };
  const options = { vault, command, env: {}, redact: (text: string) => text };
  await auditTask(store, request, options);
  expect(prompts[0]).toContain("Is this task fair?");
  expect(await readTaskAudit(store, task)).toMatchObject({
    audit: { verdict: "unfair", text: "The tests want a format.", attempts: 1, failures: 1 },
  });

  reply = {
    exitCode: 1,
    stdout: "",
    stderr: '401 {"error":{"message":"Authentication failed.","type":"authentication_error"}}',
  };
  await expect(auditTask(store, request, options)).rejects.toThrow("Authentication failed.");
  const { audit, failure } = await readTaskAudit(store, task);
  expect(audit?.verdict).toBe("unfair");
  expect(failure?.message).toBe("Authentication failed.");
});

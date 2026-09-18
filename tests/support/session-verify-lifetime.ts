import { mock, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@temporalio/activity";
import { LocalArtifactStore } from "../../src/artifacts.js";
import type { HarborJobResult } from "../../src/harbor-results.js";
import type { MailboxRequest } from "../../src/sandbox/supervisor.js";
import * as operations from "../../src/sandbox/task-operation.js";
import * as auth from "../../src/subscription-auth.js";
import * as harbor from "../../src/temporal/activities/harbor.js";
import * as runtime from "../../src/temporal/activities/runtime.js";
import { SessionVerifier } from "../../src/temporal/activities/session-verify.js";
import * as compiler from "../../src/temporal/activities/task-compiler.js";
import { candidate, run } from "./workflow-fixture.js";

const roots: string[] = [];
export async function cleanupFixture() {
  mock.restore();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const assigned = candidate("candidate", 1, "easy");
export const request: MailboxRequest = {
  id: "request-1",
  kind: "task",
  definition: {
    schemaVersion: 2,
    difficulty: "easy",
    taskId: "lifetime-probe",
    repo: "example/repo",
    baseCommit: assigned.baseCommit,
    workdir: ".",
    testCommand: "test {tests}",
    failToPass: ["tests/new.test"],
    passToPass: [],
    testPaths: ["tests/new.test"],
    sourcePr: assigned.sourcePr,
    sourceUrl: assigned.sourceUrl,
    prompt: "Implement the behavior.",
    timeouts: { setupSeconds: 60, agentSeconds: 60, testsSeconds: 60 },
    resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
    environment: {
      schemaVersion: 1,
      baseImage: `node:22@sha256:${"a".repeat(64)}`,
      rootSetupCommand: "true",
      setupCommand: "true",
      smokeCommand: "true",
      environmentVariables: {},
      services: [],
      source: "ci-adapted",
      evidence: [{ path: "package.json", reason: "Defines test command." }],
    },
  },
  testPatch:
    "diff --git a/tests/new.test b/tests/new.test\nnew file mode 100644\n--- /dev/null\n+++ b/tests/new.test\n@@ -0,0 +1 @@\n+test\n",
  goldPatch: `diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -0,0 +20 @@\n${Array.from({ length: 20 }, (_, i) => `+line ${i}`).join("\n")}\n`,
};
export const gateResult: HarborJobResult = {
  job: {},
  trial: {
    verifier_result: {
      rewards: {
        smoke_exit_code: 0,
        nop_structured_results: 1,
        nop_patch_applied: 1,
        nop_setup_completed: 1,
        nop_fail_to_pass: 0,
        nop_pass_to_pass: 1,
        nop_deterministic: 1,
        nop_fail_to_pass_exit_code: 10,
        nop_fail_to_pass_repeat_exit_code: 10,
        nop_pass_to_pass_exit_code: 0,
      },
    },
  },
};

export async function fixture() {
  const activity = new AbortController();
  spyOn(Context, "current").mockReturnValue({
    cancellationSignal: activity.signal,
    heartbeat: () => {},
  } as unknown as Context);
  spyOn(auth, "githubToken").mockResolvedValue(undefined);
  const root = await mkdtemp(join(tmpdir(), "selfbench-verifier-lifetime-"));
  roots.push(root);
  const store = new LocalArtifactStore(join(root, "artifacts"));
  const writes: string[] = [];
  const put = store.put.bind(store);
  spyOn(store, "put").mockImplementation(async (key, bytes, contentType) => {
    writes.push(key);
    return put(key, bytes, contentType);
  });
  spyOn(operations, "taskOperation").mockImplementation(async (operation) => {
    if (operation === "draft")
      return { "/work/source-task.tar.gz": Buffer.from("mock submission") };
    if (operation === "unpack")
      return {
        "/work/patches.json": Buffer.from(
          JSON.stringify({ testPatch: request.testPatch, goldPatch: request.goldPatch }),
        ),
      };
    throw Error(`Unexpected task operation ${operation}`);
  });
  const compilation = spyOn(compiler, "compileSubmittedTask").mockResolvedValue(
    Buffer.from("mock compiled bundle"),
  );
  const taskDirectory = join(root, "task");
  await mkdir(join(taskDirectory, "tests"), { recursive: true });
  await writeFile(join(taskDirectory, "tests/task-test.sh"), "true\n");
  // Only bundle hydration is replaced; verifier orchestration, heartbeats, and mailbox are real.
  spyOn(runtime, "withTaskBundle").mockImplementation(async (_store, _task, action, signal) => {
    signal?.throwIfAborted();
    return action(taskDirectory, root);
  });
  const gates = spyOn(harbor, "runHarborGate");
  const verifier = new SessionVerifier({
    store,
    harborEnvironment: "docker",
    run,
    candidate: assigned,
    stage: "authoring",
    round: 1,
    prefix: "round",
  });
  return { activity, store, writes, compilation, gates, verifier, rawPut: put };
}

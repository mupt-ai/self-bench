import { afterEach, expect, spyOn, test } from "bun:test";
import { compileAndVerify } from "../../../src/generation/verify/compile-and-verify.js";
import type { HarborJobResult } from "../../../src/harnesses/harbor/results.js";
import { LiveSandboxRegistry, SandboxSupervisionError } from "../../../src/sandbox/live.js";
import { MAILBOX_REQUESTS } from "../../../src/sandbox/supervisor.js";
import {
  assigned,
  cleanupFixture,
  deferred,
  fixture,
  gateResult,
  request,
} from "../../support/session-verify-lifetime.js";
import { draft, run } from "../../support/workflow-fixture.js";

afterEach(cleanupFixture);

for (const cooperative of [true, false]) {
  test(`command exit cancels the real verifier path with ${cooperative ? "cooperative" : "uncooperative"} gate settlement`, async () => {
    const f = await fixture();
    const entered = deferred<AbortSignal>();
    const gate = deferred<HarborJobResult>();
    const agents: string[] = [];
    f.gates.mockImplementation(async (_task, _jobs, agent, _id, _environment, signal) => {
      agents.push(agent);
      if (agent !== "nop") throw new Error("oracle must not start");
      entered.resolve(signal);
      if (cooperative)
        signal.addEventListener("abort", () => gate.reject(signal.reason), { once: true });
      return gate.promise;
    });
    const responses: string[] = [];
    const registry = new LiveSandboxRegistry(20);
    let hook!: Promise<void>;
    const supervision = registry.start(
      "generation",
      {
        execute: async () => ({ exitCode: 0, stdout: `${request.id}.json\n`, stderr: "" }),
        readFile: async (path) =>
          path === `${MAILBOX_REQUESTS}/${request.id}.json`
            ? Buffer.from(JSON.stringify(request))
            : undefined,
        writeFile: async (path) => {
          responses.push(path);
        },
      },
      {
        onLive: (live, exited) => {
          hook = f.verifier.supervise(live, exited);
          return hook;
        },
      },
    );
    const commandSignal = await entered.promise;
    let failure: unknown;
    try {
      await supervision.finish();
    } catch (error) {
      failure = error;
    }
    expect(commandSignal.aborted).toBe(true);
    expect(failure).toBeInstanceOf(cooperative ? Error : SandboxSupervisionError);
    const writesAtFinish = [...f.writes];
    if (!cooperative) gate.resolve(gateResult);
    await expect(hook).rejects.toThrow("sandbox command exited");
    expect(f.writes).toEqual(writesAtFinish);
    expect(f.writes.filter((key) => /smoke-nop|oracle|report\.(json|md)/.test(key))).toEqual([]);
    expect(agents).toEqual(["nop"]);
    expect(responses).toEqual([]);
    expect(f.verifier.records).toEqual([]);
    expect(f.compilation.mock.calls[0]?.[0].signal).toBeDefined();
    expect(f.compilation.mock.calls[0]?.[0].signal?.aborted).toBe(true);
  });
}

test("a late compiler success cannot publish its bundle or start Harbor after cancellation", async () => {
  const f = await fixture();
  const lifetime = new AbortController();
  const entered = deferred<AbortSignal>();
  const compiled = deferred<Uint8Array>();
  f.compilation.mockImplementation(async (input) => {
    if (!input.signal) throw new Error("missing compiler cancellation");
    entered.resolve(input.signal);
    return compiled.promise;
  });
  f.gates.mockImplementation(async () => {
    throw new Error("Harbor must not start");
  });
  const pending = f.verifier.handle(request, lifetime.signal);
  const signal = await entered.promise;
  lifetime.abort(new Error("generation ended during compile"));
  compiled.resolve(Buffer.from("late bundle"));
  await expect(pending).rejects.toThrow("generation ended during compile");
  expect(signal.aborted).toBe(true);
  expect(f.writes.some((key) => /harbor-task|report\./.test(key))).toBe(false);
  expect(f.gates).not.toHaveBeenCalled();
  expect(f.verifier.records).toEqual([]);
});

test("abort during checkpoint lookup cannot republish or restore the completed report", async () => {
  const f = await fixture();
  const lifetime = new AbortController();
  spyOn(f.store, "getByKey").mockImplementation(async () => {
    lifetime.abort(new Error("checkpoint owner ended"));
    return Buffer.from("{}");
  });
  await expect(
    compileAndVerify(
      f.store,
      "docker",
      { run, candidate: assigned, task: draft(assigned.candidateId), stage: "authoring", round: 1 },
      "round",
      lifetime.signal,
    ),
  ).rejects.toThrow("checkpoint owner ended");
  expect(f.writes).toEqual([]);
  expect(f.compilation).not.toHaveBeenCalled();
});

test("pre-aborted verification performs no artifact writes or child work", async () => {
  const f = await fixture();
  await expect(
    f.verifier.handle(request, AbortSignal.abort(new Error("already ended"))),
  ).rejects.toThrow("already ended");
  expect(f.writes).toEqual([]);
  expect(f.compilation).not.toHaveBeenCalled();
});

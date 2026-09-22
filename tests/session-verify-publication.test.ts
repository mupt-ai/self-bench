import { afterEach, expect, spyOn, test } from "bun:test";
import { ApplicationFailure } from "@temporalio/common";
import type { HarborJobResult } from "../src/harbor/results.js";
import * as processes from "../src/process.js";
import {
  cleanupFixture,
  deferred,
  fixture,
  gateResult,
  request,
} from "./support/session-verify-lifetime.js";

afterEach(cleanupFixture);

test("an active lifetime still runs the oracle and publishes a reusable green verification", async () => {
  const f = await fixture();
  f.gates.mockImplementation(async (_task, _jobs, agent) =>
    agent === "nop"
      ? gateResult
      : {
          job: {},
          trial: {
            verifier_result: {
              rewards: {
                patch_applied: 1,
                setup_completed: 1,
                fail_to_pass: 1,
                pass_to_pass: 1,
                deterministic: 1,
              },
            },
          },
        },
  );
  const response = await f.verifier.handle(request, new AbortController().signal);
  expect(response).toMatchObject({ kind: "report", green: true });
  expect(f.gates.mock.calls.map((call) => call[2])).toEqual(["nop", "oracle"]);
  expect(f.writes).toContain("round/verify-1/report.json");
  expect(
    f.verifier.verified(request.definition, request.testPatch, request.goldPatch),
  ).toBeDefined();
});

test("aborting during oracle suppresses oracle artifacts and the final report", async () => {
  const f = await fixture();
  const lifetime = new AbortController();
  const entered = deferred<AbortSignal>();
  const oracle = deferred<HarborJobResult>();
  f.gates.mockImplementation(async (_task, _jobs, agent, _id, _environment, signal) => {
    if (agent === "nop") return gateResult;
    entered.resolve(signal);
    return oracle.promise;
  });
  const pending = f.verifier.handle(request, lifetime.signal);
  const signal = await entered.promise;
  lifetime.abort(new Error("oracle owner ended"));
  oracle.resolve(gateResult);
  await expect(pending).rejects.toThrow("oracle owner ended");
  expect(signal.aborted).toBe(true);
  expect(f.writes.some((key) => /oracle|report\.(json|md)/.test(key))).toBe(false);
  expect(f.verifier.records).toEqual([]);
});

for (const diagnostic of ["docker", "modal"] as const) {
  test(`${diagnostic} failure diagnostics inherit cancellation and cannot publish a late result`, async () => {
    const f = await fixture();
    const lifetime = new AbortController();
    const entered = deferred<AbortSignal>();
    const diagnosticResult = deferred<processes.CommandResult>();
    const runCommand = processes.runCommand;
    spyOn(processes, "runCommand").mockImplementation((command, args, options) => {
      if (command !== diagnostic) return runCommand(command, args, options);
      if (!options?.signal) throw new Error("diagnostic missing lifetime signal");
      entered.resolve(options.signal);
      return diagnosticResult.promise;
    });
    f.gates.mockImplementation(async () => {
      if (diagnostic === "modal")
        throw ApplicationFailure.create({
          type: "HarborInfrastructureFailure",
          message: "image build failed im-test123",
        });
      return {
        job: {},
        trial: { trial_name: "test", exception_info: { exception_message: "unhealthy service" } },
      };
    });
    const pending = f.verifier.handle(request, lifetime.signal);
    const signal = await entered.promise;
    lifetime.abort(new Error("diagnostic owner ended"));
    diagnosticResult.resolve({ exitCode: 1, stdout: "", stderr: "cancelled" });
    await expect(pending).rejects.toThrow("diagnostic owner ended");
    expect(signal.aborted).toBe(true);
    expect(f.writes.some((key) => /build\.log|report\.(json|md)|oracle/.test(key))).toBe(false);
    expect(f.verifier.records).toEqual([]);
  });
}

test("normal command exit settles idle mailbox supervision without an ownership failure", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const listing = deferred<{ exitCode: number; stdout: string; stderr: string }>();
  const exited = new AbortController();
  const supervising = f.verifier.supervise(
    {
      sandboxId: "idle",
      execute: async () => {
        entered.resolve();
        return listing.promise;
      },
      readFile: async () => undefined,
      writeFile: async () => {
        throw new Error("unexpected response");
      },
    },
    exited.signal,
  );
  await entered.promise;
  exited.abort(new Error("normal exit"));
  listing.resolve({ exitCode: 0, stdout: "", stderr: "" });
  await supervising;
  expect(f.verifier.records).toEqual([]);
});

test("cancellation during report diagnostics prevents publishing the reusable checkpoint", async () => {
  const f = await fixture();
  const lifetime = new AbortController();
  f.gates.mockResolvedValue(gateResult);
  const entered = deferred<void>();
  const released = deferred<void>();
  spyOn(f.store, "put").mockImplementation(async (key, bytes, contentType) => {
    if (key.endsWith("report.md")) {
      entered.resolve();
      await released.promise;
    }
    f.writes.push(key);
    return f.rawPut(key, bytes, contentType);
  });
  const pending = f.verifier.handle(request, lifetime.signal);
  await entered.promise;
  lifetime.abort(new Error("report owner ended"));
  released.resolve();
  await expect(pending).rejects.toThrow("report owner ended");
  expect(f.writes).not.toContain("round/verify-1/report.json");
  expect(f.verifier.records).toEqual([]);
});

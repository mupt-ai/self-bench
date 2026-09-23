import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as processes from "../../../../src/lib/process.js";
import { DockerSandboxExecutor } from "../../../../src/sandbox/providers/docker/executor.js";

const ok = { exitCode: 0, stdout: "", stderr: "" };
const request = { runId: "cleanup", stage: "test", command: ["true"], timeoutMs: 1000 };
const executor = () => new DockerSandboxExecutor({ kind: "docker", image: "mock-only" });
afterEach(() => mock.restore());

function failingCleanup(primary?: Error, listingFails = false) {
  const removed: string[] = [];
  let name = "";
  spyOn(processes, "runCommand").mockImplementation(async (command, args) => {
    expect(command).toBe("docker");
    if (args[0] === "create") name = args[2] ?? "";
    if (args[0] === "start" && primary) throw primary;
    if (args.includes("rm")) {
      removed.push(args[0] === "rm" ? "container" : "volume");
      return { ...ok, exitCode: 1, stderr: "removal failed" };
    }
    if (args.includes("ls"))
      return listingFails
        ? { ...ok, exitCode: 1, stderr: "daemon unavailable" }
        : { ...ok, stdout: `${JSON.stringify(name)}\n` };
    return ok;
  });
  return removed;
}

test("successful workload rejects when both Docker removals fail", async () => {
  const removed = failingCleanup();
  await expect(executor().run(request)).rejects.toMatchObject({
    name: "DockerSandboxCleanupError",
    ownershipFailure: true,
  });
  expect(removed).toEqual(["container", "volume"]);
});

test("daemon failure cannot establish absence", async () => {
  const removed = failingCleanup(undefined, true);
  await expect(executor().run(request)).rejects.toMatchObject({ ownershipFailure: true });
  expect(removed).toEqual(["container", "volume"]);
});

test("cleanup preserves extensible primary error identity and adds cleanup marker", async () => {
  const primary = new Error("workload failed");
  const removed = failingCleanup(primary);
  const error: unknown = await executor()
    .run(request)
    .catch((error: unknown) => error);
  expect(error).toBe(primary);
  expect(error).toMatchObject({ cleanupError: { ownershipFailure: true } });
  expect(primary.message).toContain("workload failed");
  expect(removed).toEqual(["container", "volume"]);
});

test("frozen primary remains the cause with its original name", async () => {
  const primary = Object.freeze(new TypeError("frozen workload failure"));
  failingCleanup(primary);
  const error: unknown = await executor()
    .run(request)
    .catch((error: unknown) => error);
  expect(error).toMatchObject({
    name: "TypeError",
    cause: primary,
    cleanupError: { ownershipFailure: true },
  });
});

test("failed removals followed by authoritative absence retain workload success", async () => {
  spyOn(processes, "runCommand").mockImplementation(async (_, args) =>
    args.includes("rm") ? { ...ok, exitCode: 1 } : ok,
  );
  await expect(executor().run(request)).resolves.toMatchObject({ exitCode: 0 });
});

test("cancelled workload still cleans up using independent signals", async () => {
  const controller = new AbortController();
  const reason = new Error("cancelled workload");
  const removals: string[] = [];
  spyOn(processes, "runCommand").mockImplementation(async (_, args, options) => {
    if (args[0] === "start") {
      controller.abort(reason);
      throw reason;
    }
    if (args.includes("rm")) {
      removals.push(args[0] ?? "");
      expect(options?.signal).not.toBe(controller.signal);
      expect(options?.signal?.aborted).toBe(false);
    }
    return ok;
  });
  await expect(executor().run(request, { signal: controller.signal })).rejects.toBe(reason);
  expect(removals).toEqual(["rm", "volume"]);
});

for (const cancelled of [false, true]) {
  for (const mode of ["command", "hook", "both", "both-cleanup"] as const) {
    test(`${mode} failure retains diagnostics and settles supervision (cancelled=${cancelled})`, async () => {
      const primary = new Error("command failure");
      const hook = new Error("hook failure");
      const controller = new AbortController();
      const runner = executor();
      const removals: string[] = [];
      let settled = false;
      let sandboxId = "";
      spyOn(processes, "runCommand").mockImplementation(async (_, args, options) => {
        if (args[0] === "create") sandboxId = args[2] ?? "";
        if (args[0] === "start") {
          if (cancelled) controller.abort(primary);
          if (mode !== "hook") throw primary;
        }
        if (args.includes("rm")) {
          expect(settled).toBe(true);
          expect(options?.signal?.aborted).toBe(false);
          removals.push(args[0] ?? "");
          if (mode === "both-cleanup") return { ...ok, exitCode: 1 };
        }
        if (args.includes("ls")) return { ...ok, exitCode: 1, stderr: "daemon unavailable" };
        return ok;
      });
      const error: unknown = await runner
        .run(request, {
          signal: controller.signal,
          onLive: async (_, exited) => {
            if (!exited.aborted)
              await new Promise<void>((resolve) => {
                exited.addEventListener("abort", () => resolve(), { once: true });
              });
            settled = true;
            if (mode !== "command") throw hook;
          },
        })
        .catch((error: unknown) => error);
      if (mode === "command") expect(error).toBe(primary);
      else if (mode === "hook") expect(error).toBe(hook);
      else {
        expect(error).toMatchObject({
          cause: primary,
          supervisionError: hook,
          ownershipFailure: true,
        });
        if (mode === "both-cleanup") {
          expect(error).toMatchObject({ cleanupError: { ownershipFailure: true } });
        }
      }
      expect(settled).toBe(true);
      expect(removals).toEqual(["rm", "volume"]);
      expect(() => runner.execute(sandboxId, ["true"])).toThrow("is not running");
    });
  }
}

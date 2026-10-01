import { expect, test } from "bun:test";
import { CancelledFailure } from "@temporalio/common";
import { HARBOR_ENVIRONMENTS } from "../../src/contracts/config/providers.js";
import {
  harborProcessEnvironment,
  harborRunArguments,
  runHarbor,
} from "../../src/harnesses/harbor/command.js";
import { runCommand } from "../../src/lib/process.js";

test("all Harbor providers share invocation policy without acquiring solver retry semantics in gates", () => {
  for (const environment of HARBOR_ENVIRONMENTS) {
    for (const agent of ["nop", "oracle"] as const) {
      const args = harborRunArguments({
        taskPath: "/task with spaces",
        jobsPath: "/jobs",
        jobName: "gate",
        environment,
        agent,
        quiet: true,
      });
      // Modal runs through SelfBench's subclass, which pins and records task images.
      expect(args[args.indexOf("--env") + 1]).toBe(
        environment === "modal" ? "selfbench_modal:SelfBenchModalEnvironment" : environment,
      );
      expect(args[args.indexOf("--path") + 1]).toBe("/task with spaces");
      expect(args).not.toContain("--model");
      expect(args[args.indexOf("--max-retries") + 1]).toBe("0");
      expect(args).toContain("--quiet");
      expect(args).toContain("--delete");
    }
  }
});

test("solver policy forbids implicit repeat spend and keeps agent options as argv", () => {
  const args = harborRunArguments({
    taskPath: "/task",
    jobsPath: "/jobs",
    jobName: "solver",
    environment: "docker",
    agent: "codex",
    solver: { model: "model; not a shell", agentArguments: ["--ak", "reasoning_effort=high"] },
  });
  expect(args[args.indexOf("--model") + 1]).toBe("model; not a shell");
  expect(args[args.indexOf("--max-retries") + 1]).toBe("0");
  expect(args[args.indexOf("--n-attempts") + 1]).toBe("1");
  expect(args.slice(-2)).toEqual(["--ak", "reasoning_effort=high"]);
  expect(args).not.toContain("--quiet");
});

test("process setup does not mutate or reinterpret already isolated credentials", () => {
  const input = Object.freeze({
    E2B_API_KEY: "solver-key",
    HOME: "/private/home",
    PYTHONPATH: "/untrusted",
  });
  const child = harborProcessEnvironment(input);
  expect(child.E2B_API_KEY).toBe("solver-key");
  expect(child.HOME).toBe("/private/home");
  expect(child.PYTHONPATH).not.toBe(input.PYTHONPATH);
  expect(input.PYTHONPATH).toBe("/untrusted");
  expect(child.COLUMNS).toBe("320");
  expect(child.HARBOR_TELEMETRY).toBe("off");
});

test("Docker packaging and the process policy pin the same Harbor version", async () => {
  const { HARBOR_VERSION } = await import("../../src/harnesses/harbor/command.js");
  const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
  expect(dockerfile.match(/^ARG HARBOR_VERSION=(.+)$/m)?.[1]).toBe(HARBOR_VERSION);
});

/**
 * Stands in for `harbor run`: on SIGTERM it cleans up for a moment, as Harbor's cancel path does,
 * and every sweep records whether that cleanup had finished.
 */
function stoppableHarbor() {
  const events: string[] = [];
  const sandboxes = {
    environmentKwargs: {},
    sweep: async () => {
      events.push("sweep");
    },
  };
  const command: typeof runCommand = (_command, _args, options) =>
    runCommand(
      "bash",
      ["-c", "trap 'sleep 0.5; exit 0' TERM; while true; do sleep 0.05; done"],
      options,
    ).finally(() => events.push("exited"));
  return { events, sandboxes, command };
}

test("a Harbor run sweeps its sandboxes once Harbor has exited, however it was stopped", async () => {
  for (const reason of [undefined, new CancelledFailure("CANCELLED")]) {
    const { events, sandboxes, command } = stoppableHarbor();
    const controller = new AbortController();
    setTimeout(() => controller.abort(reason), 100);
    await runHarbor(sandboxes, ["run"], { signal: controller.signal }, command).catch(
      () => undefined,
    );
    expect(events).toEqual(["exited", "sweep"]);
  }
});

test("a Harbor run sweeps its sandboxes at once when the worker shuts down", async () => {
  const { events, sandboxes, command } = stoppableHarbor();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new CancelledFailure("WORKER_SHUTDOWN")), 100);
  await runHarbor(sandboxes, ["run"], { signal: controller.signal }, command).catch(
    () => undefined,
  );
  expect(events).toEqual(["sweep", "exited", "sweep"]);
});

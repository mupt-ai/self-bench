import { expect, test } from "bun:test";
import { HARBOR_ENVIRONMENTS } from "../../src/config/providers.js";
import {
  HARBOR_PROCESS_TIMEOUT_MS,
  harborProcessEnvironment,
  harborRunArguments,
} from "../../src/harbor/command.js";

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
      expect(args[args.indexOf("--env") + 1]).toBe(environment);
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
  expect(HARBOR_PROCESS_TIMEOUT_MS.gate).toBe(10800000);
  expect(HARBOR_PROCESS_TIMEOUT_MS.solver).toBe(7200000);
});

test("Docker packaging and the process policy pin the same Harbor version", async () => {
  const { HARBOR_VERSION } = await import("../../src/harbor/command.js");
  const dockerfile = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
  expect(dockerfile.match(/^ARG HARBOR_VERSION=(.+)$/m)?.[1]).toBe(HARBOR_VERSION);
});

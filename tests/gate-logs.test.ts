import { describe, expect, test } from "bun:test";
import { COMPOSE_DIAGNOSTICS_MARKER } from "../src/log-excerpt.js";
import type { runCommand } from "../src/process.js";
import {
  composeDiagnostics,
  composeProjectName,
  isUnhealthyServiceFailure,
} from "../src/temporal/activities/gate-logs.js";

type Runner = typeof runCommand;

describe("compose diagnostics", () => {
  test("mirrors Harbor's compose project naming", () => {
    expect(composeProjectName("Trial.Name__env")).toBe("trial-name__env");
    expect(composeProjectName("_x")).toBe("0_x");
    expect(isUnhealthyServiceFailure("dependency failed to start: container db is unhealthy")).toBe(
      true,
    );
    expect(isUnhealthyServiceFailure("tests failed")).toBe(false);
  });

  test("says so when the project is gone or the environment is not Docker", async () => {
    const gone = await composeDiagnostics({ trial_name: "t1" }, "docker", (async () => ({
      exitCode: 0,
      stdout: "NAME  STATUS\n",
      stderr: "",
    })) as unknown as Runner);
    expect(gone).toContain(
      `${COMPOSE_DIAGNOSTICS_MARKER} (project t1__env): the compose project is no longer available`,
    );
    expect(await composeDiagnostics({ trial_name: "t1" }, "modal")).toContain(
      "not available on the modal Harbor environment",
    );
    expect(await composeDiagnostics({}, "docker")).toContain("trial name is missing");
  });

  test("includes ps output and the last 30 log lines of unhealthy services", async () => {
    const calls: string[][] = [];
    const runner = (async (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args.includes("ps")) {
        return {
          exitCode: 0,
          stdout: "NAME       STATUS\nmain       running\npostgres   Exited (1) unhealthy\n",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "FATAL: password authentication failed\n", stderr: "" };
    }) as unknown as Runner;

    const block = await composeDiagnostics({ trial_name: "Trial 7" }, "docker", runner);

    expect(block).toContain(`${COMPOSE_DIAGNOSTICS_MARKER} (project trial-7__env)`);
    expect(block).toContain("postgres   Exited (1) unhealthy");
    expect(block).toContain(
      "--- postgres (last 30 lines) ---\nFATAL: password authentication failed",
    );
    expect(block).not.toContain("--- main");
    expect(calls.some((args) => args.join(" ").includes("logs --tail 30 postgres"))).toBe(true);
  });
});

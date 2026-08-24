import { describe, expect, test } from "bun:test";
import {
  HOBBY_VERCEL_TIMEOUT_CAP_MS,
  STANDARD_VERCEL_TIMEOUT_CAP_MS,
} from "../src/sandbox/timeout.js";
import { probeVercelCapability, type VercelSandboxProbeApi } from "../src/setup/vercel/probe.js";

const credentials = {
  token: "vcp_super_secret",
  teamId: "team_test",
  projectId: "prj_test",
};
const image = `selfbench-runtime@sha256:${"a".repeat(64)}`;

class FakeProbeApi implements VercelSandboxProbeApi {
  readonly createTimeouts: number[] = [];
  deleteCount = 0;
  getCount = 0;
  firstCreateError: Error | undefined;
  commandExitCode = 0;
  deleteError: Error | undefined;
  getError: Error | undefined;
  recoveredSandboxExists = false;

  async create(input: Parameters<VercelSandboxProbeApi["create"]>[0]) {
    this.createTimeouts.push(input.timeout);
    if (this.firstCreateError) {
      const error = this.firstCreateError;
      this.firstCreateError = undefined;
      throw error;
    }
    return {
      name: input.name,
      runCommand: async () => ({ exitCode: this.commandExitCode }),
      delete: async () => {
        this.deleteCount += 1;
        if (this.deleteError) {
          throw this.deleteError;
        }
      },
    };
  }

  get(
    _input: Parameters<VercelSandboxProbeApi["get"]>[0],
  ): ReturnType<VercelSandboxProbeApi["get"]> {
    this.getCount += 1;
    if (this.getError) {
      return Promise.reject(this.getError);
    }
    if (this.recoveredSandboxExists) {
      return Promise.resolve({
        name: "recovered",
        runCommand: async () => ({ exitCode: 0 }),
        delete: async () => {
          this.deleteCount += 1;
          this.recoveredSandboxExists = false;
        },
      });
    }
    return Promise.reject(Object.assign(new Error("not found"), { status: 404 }));
  }
}

describe("Vercel setup capability probe", () => {
  test("verifies command execution and terminal deletion at the standard SelfBench ceiling", async () => {
    const api = new FakeProbeApi();

    const result = await probeVercelCapability({ credentials, image }, api);

    expect(result).toMatchObject({
      timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
      timeoutClass: "standard",
    });
    expect(api.createTimeouts).toEqual([STANDARD_VERCEL_TIMEOUT_CAP_MS]);
    expect(api.deleteCount).toBe(1);
    expect(api.getCount).toBe(1);
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
  });

  test("detects the provider's exact 45-minute response and verifies that ceiling", async () => {
    const api = new FakeProbeApi();
    api.firstCreateError = Object.assign(
      new Error("Vercel Sandbox API error: `timeout` should be <= 45m"),
      { status: 400 },
    );

    const result = await probeVercelCapability({ credentials, image }, api);

    expect(result.timeoutClass).toBe("45m");
    expect(result.timeoutCapMs).toBe(HOBBY_VERCEL_TIMEOUT_CAP_MS);
    expect(api.createTimeouts).toEqual([
      STANDARD_VERCEL_TIMEOUT_CAP_MS,
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
    ]);
    expect(api.deleteCount).toBe(1);
  });

  test("does not misclassify other failures and redacts the access token", async () => {
    const api = new FakeProbeApi();
    api.firstCreateError = Object.assign(new Error(`unauthorized ${credentials.token}`), {
      status: 401,
    });

    const failure = probeVercelCapability({ credentials, image }, api);

    await expect(failure).rejects.toThrow("unauthorized [redacted]");
    await expect(failure).rejects.not.toThrow(credentials.token);
    expect(api.createTimeouts).toEqual([STANDARD_VERCEL_TIMEOUT_CAP_MS]);
  });

  test("recovers a lost delete response when exact-name lookup confirms absence", async () => {
    const api = new FakeProbeApi();
    api.deleteError = new Error("delete unavailable");

    await expect(probeVercelCapability({ credentials, image }, api)).resolves.toMatchObject({
      timeoutClass: "standard",
    });
    expect(api.getCount).toBe(1);
  });

  test("recovers an exact-name allocation after losing the create response", async () => {
    const api = new FakeProbeApi();
    api.firstCreateError = new Error("connection lost after allocation");
    api.recoveredSandboxExists = true;

    await expect(probeVercelCapability({ credentials, image }, api)).rejects.toThrow(
      "connection lost after allocation",
    );
    expect(api.deleteCount).toBe(1);
    expect(api.recoveredSandboxExists).toBe(false);
    expect(api.getCount).toBeGreaterThanOrEqual(2);
  });

  test("fails setup when its temporary sandbox cannot be cleaned up or recovered", async () => {
    const api = new FakeProbeApi();
    api.deleteError = new Error("delete unavailable");
    api.getError = Object.assign(new Error("recovery unavailable"), { status: 503 });

    await expect(probeVercelCapability({ credentials, image }, api)).rejects.toThrow(
      "could not be deleted cleanly",
    );
  });
});

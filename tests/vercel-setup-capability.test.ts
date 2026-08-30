import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOBBY_VERCEL_TIMEOUT_CAP_MS } from "../src/sandbox/timeout.js";
import { loadVercelProfileData } from "../src/setup/vercel/profile.js";
import { vercelRuntimeFingerprint } from "../src/setup/vercel/runtime-image.js";
import { setupVercel } from "../src/setup/vercel/setup.js";
import {
  configDirectory,
  FakeCli,
  FakePrompter,
  makeServices,
  repositoryRoot,
  roots,
} from "./support/vercel-setup-fixture.js";

describe("self-bench Vercel capability setup", () => {
  test("records the 45-minute cap only after explicit confirmation", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    const prompter = new FakePrompter();
    prompter.confirmations.push(true);
    const logs: string[] = [];
    const capability = {
      timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
      timeoutClass: "45m" as const,
      checkedAt: "2026-08-16T13:00:00.000Z",
    };

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, prompter, logs, async () => capability),
    );

    expect(result.profile.timeoutCapMs).toBe(HOBBY_VERCEL_TIMEOUT_CAP_MS);
    expect((await loadVercelProfileData(directory)).profiles.default?.timeoutCapMs).toBe(
      HOBBY_VERCEL_TIMEOUT_CAP_MS,
    );
    expect(logs.join("\n")).toContain("45-minute Sandbox limit");
    expect(logs.join("\n")).toContain("personal, non-commercial");
    expect(logs).toContain("Timeout cap: 45m");
    expect(logs).toContain("Vercel tier: Hobby-compatible");
  });
  test("does not activate a profile when capability confirmation is declined", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    const prompter = new FakePrompter();
    prompter.confirmations.push(false);

    await expect(
      setupVercel(
        { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
        makeServices(cli, prompter, [], async () => ({
          timeoutCapMs: HOBBY_VERCEL_TIMEOUT_CAP_MS,
          timeoutClass: "45m",
          checkedAt: "2026-08-16T13:00:00.000Z",
        })),
      ),
    ).rejects.toThrow("canceled before profile activation");

    expect((await loadVercelProfileData(directory)).profiles).toEqual({});
  });
  test("does not activate a profile when token verification fails and explains replacement", async () => {
    const directory = await configDirectory();

    await expect(
      setupVercel(
        { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
        makeServices(new FakeCli(), new FakePrompter(), [], async () => {
          throw new Error("401 unauthorized");
        }),
      ),
    ).rejects.toThrow("paste a new project-scoped token");

    expect((await loadVercelProfileData(directory)).profiles).toEqual({});
  });
  test("fails before external work outside a TTY and explains environment-only setup", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    const services = { ...makeServices(cli, new FakePrompter(), []), interactive: false };

    await expect(
      setupVercel(
        { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
        services,
      ),
    ).rejects.toThrow("requires an interactive terminal");
    expect(cli.availableChecks).toBe(0);
  });
  test("fingerprints every current image input and refuses to ignore future local copies", async () => {
    const first = await vercelRuntimeFingerprint(repositoryRoot);
    const second = await vercelRuntimeFingerprint(repositoryRoot);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const root = await mkdtemp(join(tmpdir(), "selfbench-vcr-fingerprint-"));
    roots.push(root);
    await writeFile(join(root, "Dockerfile.sandbox"), "FROM node:22\nCOPY package.json /work/\n");
    await expect(vercelRuntimeFingerprint(root)).rejects.toThrow(
      "update the VCR fingerprint inputs",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { vercelRuntimeFingerprint } from "../src/setup/vercel/runtime-image.js";
import { setupVercel } from "../src/setup/vercel/setup.js";
import {
  configDirectory,
  digest,
  FakeCli,
  FakePrompter,
  makeServices,
  repositoryRoot,
} from "./support/vercel-setup-fixture.js";

describe("self-bench Vercel image setup", () => {
  test("rebuilds an unusable OCI index instead of saving its digest", async () => {
    const directory = await configDirectory();
    const fingerprint = await vercelRuntimeFingerprint(repositoryRoot);
    const cli = new FakeCli();
    cli.repositories.add("selfbench-runtime");
    cli.tags.set("selfbench-runtime", [
      {
        tag: `selfbench-${fingerprint}`,
        manifestDigest: `sha256:${"e".repeat(64)}`,
        kind: "index",
        status: null,
      },
    ]);
    const logs: string[] = [];

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, new FakePrompter(), logs),
    );

    expect(result.imagePublished).toBe(true);
    expect(result.profile.image).toBe(`selfbench-runtime@${digest}`);
    expect(cli.builds).toHaveLength(1);
    expect(logs.join("\n")).toContain("unsupported OCI index");
  });
  test("rebuilds an unoptimized manifest instead of treating it as Sandbox-ready", async () => {
    const directory = await configDirectory();
    const fingerprint = await vercelRuntimeFingerprint(repositoryRoot);
    const cli = new FakeCli();
    cli.repositories.add("selfbench-runtime");
    cli.tags.set("selfbench-runtime", [
      {
        tag: `selfbench-${fingerprint}`,
        manifestDigest: `sha256:${"e".repeat(64)}`,
        kind: "manifest",
        status: "unoptimized",
      },
    ]);
    const logs: string[] = [];

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, new FakePrompter(), logs),
    );

    expect(result.imagePublished).toBe(true);
    expect(result.profile.image).toBe(`selfbench-runtime@${digest}`);
    expect(cli.builds).toHaveLength(1);
    expect(logs.join("\n")).toContain("unoptimized");
  });
  test("waits for an unclassified manifest instead of rebuilding its immutable tag", async () => {
    const directory = await configDirectory();
    const fingerprint = await vercelRuntimeFingerprint(repositoryRoot);
    const cli = new FakeCli();
    const tag = `selfbench-${fingerprint}`;
    cli.repositories.add("selfbench-runtime");
    cli.tags.set("selfbench-runtime", [
      {
        tag,
        manifestDigest: digest,
        kind: "manifest",
        status: null,
      },
    ]);
    cli.inspectResults.push({ tag, manifestDigest: digest, kind: "manifest", status: "ready" });

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, new FakePrompter(), []),
    );

    expect(result.imagePublished).toBe(false);
    expect(cli.builds).toHaveLength(0);
  });
  test("re-prompts for an unavailable project name but surfaces unrelated creation failures", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    cli.projects.push({ id: "prj_taken", name: "selfbench-sandbox" });
    const prompter = new FakePrompter();
    prompter.texts.push("bad---name", "", "selfbench-custom");
    const logs: string[] = [];

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, prompter, logs),
    );

    expect(result.profile.projectName).toBe("selfbench-custom");
    expect(logs.join("\n")).toContain("cannot contain three consecutive hyphens");
    expect(logs.join("\n")).toContain("already in use");

    const failedDirectory = await configDirectory();
    const failingCli = new FakeCli();
    failingCli.createProjectError = new Error("billing disabled");
    await expect(
      setupVercel(
        {
          environment: { SELFBENCH_CONFIG_DIR: failedDirectory },
          projectRoot: repositoryRoot,
        },
        makeServices(failingCli, new FakePrompter(), []),
      ),
    ).rejects.toThrow('Unable to create project "selfbench-sandbox": billing disabled');
  });
});

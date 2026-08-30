import { describe, expect, test } from "bun:test";
import { STANDARD_VERCEL_TIMEOUT_CAP_MS } from "../src/sandbox/timeout.js";
import { loadVercelProfileData, saveVercelProfile } from "../src/setup/vercel/profile.js";
import { vercelRuntimeFingerprint } from "../src/setup/vercel/runtime-image.js";
import { setupVercel } from "../src/setup/vercel/setup.js";
import {
  configDirectory,
  digest,
  FakeCli,
  FakePrompter,
  makeServices,
  repositoryRoot,
  standardCapability,
  team,
} from "./support/vercel-setup-fixture.js";

describe("self-bench Vercel project setup", () => {
  test("creates a dedicated project, publishes the runtime once, probes, and activates securely", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    const prompter = new FakePrompter();
    const logs: string[] = [];
    const probeTokens: string[] = [];
    const services = makeServices(cli, prompter, logs, async ({ credentials }) => {
      probeTokens.push(credentials.token);
      return standardCapability();
    });

    const result = await setupVercel(
      {
        environment: { SELFBENCH_CONFIG_DIR: directory },
        projectRoot: repositoryRoot,
      },
      services,
    );

    expect(result.projectCreated).toBe(true);
    expect(result.imagePublished).toBe(true);
    expect(result.profile.projectName).toBe("selfbench-sandbox");
    expect(result.profile.vcrRepository).toBe("selfbench-runtime");
    expect(result.profile.image).toBe(`selfbench-runtime@${digest}`);
    expect(result.profile.timeoutCapMs).toBe(STANDARD_VERCEL_TIMEOUT_CAP_MS);
    expect(cli.builds).toHaveLength(1);
    expect(cli.availableChecks).toBe(1);
    expect(cli.loginChecks).toBe(1);
    expect(probeTokens).toEqual(["vcp_project_secret"]);
    expect(logs).toContain("https://vercel.com/account/settings/tokens");
    expect(logs.join("\n")).not.toContain("/~/settings/tokens");
    expect(logs).toContain("Timeout cap: 2h");
    expect(logs).toContain("Vercel tier: Pro/Enterprise-compatible");
    expect(logs.some((line) => line.startsWith("Reason:"))).toBe(false);
    expect(logs).toContain("Runtime image: selfbench-runtime");
    expect(logs).toContain(`  ${digest}`);

    const stored = await loadVercelProfileData(directory);
    expect(stored.activeVercelProfile).toBe("default");
    expect(stored.profiles.default).toEqual(result.profile);
    expect(stored.tokens.default).toBe("vcp_project_secret");
    expect(logs.join("\n")).not.toContain("vcp_project_secret");
  });
  test("revalidates an existing profile without republishing or asking for its token", async () => {
    const directory = await configDirectory();
    const fingerprint = await vercelRuntimeFingerprint(repositoryRoot);
    const cli = new FakeCli();
    cli.projects.push({ id: "prj_existing", name: "existing" });
    cli.repositories.add("selfbench-runtime");
    cli.tags.set("selfbench-runtime", [
      {
        tag: `selfbench-${fingerprint}`,
        manifestDigest: digest,
        status: "ready",
      },
    ]);
    await saveVercelProfile({
      directory,
      profileName: "default",
      token: "stored-token",
      profile: {
        teamId: team.id,
        teamSlug: team.slug,
        teamName: team.name,
        projectId: "prj_existing",
        projectName: "old-name",
        vcrRepository: "selfbench-runtime",
        image: `selfbench-runtime@${digest}`,
        runtimeFingerprint: fingerprint,
        timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
        capabilityCheckedAt: "2026-08-16T12:00:00.000Z",
      },
    });
    const prompter = new FakePrompter();
    prompter.selections.push("revalidate");
    let observedToken = "";
    const services = makeServices(cli, prompter, [], async ({ credentials }) => {
      observedToken = credentials.token;
      return standardCapability();
    });

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      services,
    );

    expect(result.imagePublished).toBe(false);
    expect(result.profile.projectName).toBe("existing");
    expect(cli.builds).toHaveLength(0);
    expect(prompter.secretPrompts).toBe(0);
    expect(observedToken).toBe("stored-token");
  });
  test("protects a mixed VCR repository and accepts an explicit replacement name", async () => {
    const directory = await configDirectory();
    const fingerprint = await vercelRuntimeFingerprint(repositoryRoot);
    const cli = new FakeCli();
    cli.projects.push({ id: "prj_existing", name: "existing" });
    cli.repositories.add("selfbench-runtime");
    cli.tags.set("selfbench-runtime", [
      { tag: "production", manifestDigest: `sha256:${"d".repeat(64)}`, status: "ready" },
      {
        tag: `selfbench-${fingerprint}`,
        manifestDigest: `sha256:${"e".repeat(64)}`,
        status: "ready",
      },
    ]);
    const prompter = new FakePrompter();
    prompter.selections.push(team.id, "existing", "prj_existing");
    prompter.texts.push("Invalid/Repository", "selfbench-runtime-2");
    const logs: string[] = [];

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, prompter, logs),
    );

    expect(result.profile.vcrRepository).toBe("selfbench-runtime-2");
    expect(cli.tags.get("selfbench-runtime")).toHaveLength(2);
    expect(cli.builds).toEqual([
      {
        repository: "selfbench-runtime-2",
        tag: `selfbench-${result.profile.runtimeFingerprint}`,
      },
    ]);
    expect(logs.join("\n")).toContain("contains unrelated images");
    expect(logs.join("\n")).toContain("VCR repository names require");
  });
  test("recovers when VCR repository creation succeeds but its response is lost", async () => {
    const directory = await configDirectory();
    const cli = new FakeCli();
    cli.createRepositoryErrorAfterCreate = new Error("connection lost after create");

    const result = await setupVercel(
      { environment: { SELFBENCH_CONFIG_DIR: directory }, projectRoot: repositoryRoot },
      makeServices(cli, new FakePrompter(), []),
    );

    expect(result.imagePublished).toBe(true);
    expect(cli.builds).toHaveLength(1);
    expect(cli.repositories.has("selfbench-runtime")).toBe(true);
  });
});

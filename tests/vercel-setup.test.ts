import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOutputHandler } from "../src/process.js";
import {
  HOBBY_VERCEL_TIMEOUT_CAP_MS,
  STANDARD_VERCEL_TIMEOUT_CAP_MS,
} from "../src/sandbox/timeout.js";
import type { VcrTag, VercelProject, VercelTeam } from "../src/setup/vercel/cli.js";
import { loadVercelProfileData, saveVercelProfile } from "../src/setup/vercel/profile.js";
import { vercelRuntimeFingerprint } from "../src/setup/vercel/runtime-image.js";
import {
  setupVercel,
  type VercelSetupCli,
  type VercelSetupServices,
} from "../src/setup/vercel/setup.js";
import type { PromptChoice, SetupPrompter } from "../src/terminal-prompts.js";
import type { SetupReporter, SetupTaskLabels } from "../src/terminal-reporter.js";

const roots: string[] = [];
const repositoryRoot = join(import.meta.dir, "..");
const digest = `sha256:${"c".repeat(64)}`;
const team: VercelTeam = {
  id: "team_test",
  slug: "test-team",
  name: "Test Team",
  current: true,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

class FakePrompter implements SetupPrompter {
  readonly selections: string[] = [];
  readonly texts: string[] = [];
  readonly secrets: string[] = [];
  readonly confirmations: boolean[] = [];
  secretPrompts = 0;

  async select(
    _message: string,
    choices: readonly PromptChoice[],
    defaultValue?: string,
  ): Promise<string> {
    const selected = this.selections.shift() ?? defaultValue ?? choices[0]?.value;
    if (!selected || !choices.some(({ value }) => value === selected)) {
      throw new Error(`invalid fake selection ${selected}`);
    }
    return selected;
  }

  async search(
    message: string,
    choices: readonly PromptChoice[],
    defaultValue?: string,
  ): Promise<string> {
    return await this.select(message, choices, defaultValue);
  }

  async text(_message: string, defaultValue?: string): Promise<string> {
    const value = this.texts.shift();
    return value === undefined || value === "" ? (defaultValue ?? "") : value;
  }

  async secret(_message: string): Promise<string> {
    this.secretPrompts += 1;
    return this.secrets.shift() ?? "vcp_project_secret";
  }

  async confirm(_message: string, defaultValue: boolean): Promise<boolean> {
    return this.confirmations.shift() ?? defaultValue;
  }
}

class FakeReporter implements SetupReporter {
  constructor(readonly logs: string[]) {}

  intro(title: string): void {
    this.logs.push(title);
  }

  message(message: string): void {
    this.logs.push(message);
  }

  warn(message: string): void {
    this.logs.push(message);
  }

  cancel(message: string): void {
    this.logs.push(message);
  }

  async task<T>(
    labels: SetupTaskLabels,
    operation: (onOutput: CommandOutputHandler) => Promise<T>,
  ): Promise<T> {
    this.logs.push(labels.pending);
    const result = await operation(() => undefined);
    this.logs.push(labels.success);
    return result;
  }

  finish(title: string, details: readonly string[]): void {
    this.logs.push(title, ...details);
  }
}

class FakeCli implements VercelSetupCli {
  readonly teams: VercelTeam[] = [team];
  readonly projects: VercelProject[] = [];
  readonly repositories = new Set<string>();
  readonly tags = new Map<string, VcrTag[]>();
  readonly inspectResults: Array<VcrTag | undefined> = [];
  readonly builds: Array<{ repository: string; tag: string }> = [];
  availableChecks = 0;
  loginChecks = 0;
  createProjectError: Error | undefined;
  createRepositoryErrorAfterCreate: Error | undefined;

  async ensureAvailable(): Promise<void> {
    this.availableChecks += 1;
  }

  async ensureLoggedIn(): Promise<void> {
    this.loginChecks += 1;
  }

  async listTeams(): Promise<readonly VercelTeam[]> {
    return this.teams;
  }

  async listProjects(_teamSlug: string): Promise<readonly VercelProject[]> {
    return this.projects;
  }

  async createProject(_teamSlug: string, projectName: string): Promise<VercelProject> {
    if (this.createProjectError) {
      throw this.createProjectError;
    }
    const project = { id: `prj_${projectName}`, name: projectName };
    this.projects.push(project);
    return project;
  }

  async repositoryExists(input: { readonly repository: string }): Promise<boolean> {
    return this.repositories.has(input.repository);
  }

  async createRepository(input: { readonly repository: string }): Promise<void> {
    this.repositories.add(input.repository);
    this.tags.set(input.repository, []);
    if (this.createRepositoryErrorAfterCreate) {
      const error = this.createRepositoryErrorAfterCreate;
      this.createRepositoryErrorAfterCreate = undefined;
      throw error;
    }
  }

  async listTags(input: { readonly repository: string }): Promise<readonly VcrTag[]> {
    return this.tags.get(input.repository) ?? [];
  }

  async inspectTag(input: {
    readonly repository: string;
    readonly tag: string;
  }): Promise<VcrTag | undefined> {
    if (this.inspectResults.length > 0) {
      return this.inspectResults.shift();
    }
    return this.tags.get(input.repository)?.find(({ tag }) => tag === input.tag);
  }

  async buildImage(input: { readonly repository: string; readonly tag: string }): Promise<void> {
    this.builds.push({ repository: input.repository, tag: input.tag });
    this.tags.set(input.repository, [{ tag: input.tag, manifestDigest: digest, status: "ready" }]);
  }
}

describe("self-bench setup vercel", () => {
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

function makeServices(
  cli: FakeCli,
  prompter: FakePrompter,
  logs: string[],
  probe: VercelSetupServices["probe"] = async () => standardCapability(),
): VercelSetupServices {
  return {
    cli,
    prompter,
    reporter: new FakeReporter(logs),
    interactive: true,
    loadProfiles: loadVercelProfileData,
    saveProfile: saveVercelProfile,
    probe,
    sleep: async () => undefined,
  };
}

function standardCapability() {
  return {
    timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
    timeoutClass: "standard" as const,
    checkedAt: "2026-08-16T13:00:00.000Z",
  };
}

async function configDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-setup-"));
  roots.push(root);
  return join(root, ".selfbench");
}

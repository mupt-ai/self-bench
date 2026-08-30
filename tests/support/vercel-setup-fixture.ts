import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandOutputHandler } from "../../src/process.js";
import { STANDARD_VERCEL_TIMEOUT_CAP_MS } from "../../src/sandbox/timeout.js";
import type { VcrTag, VercelProject, VercelTeam } from "../../src/setup/vercel/cli.js";
import { loadVercelProfileData, saveVercelProfile } from "../../src/setup/vercel/profile.js";
import type { VercelSetupCli, VercelSetupServices } from "../../src/setup/vercel/setup.js";
import type { PromptChoice, SetupPrompter } from "../../src/terminal-prompts.js";
import type { SetupReporter, SetupTaskLabels } from "../../src/terminal-reporter.js";

export const roots: string[] = [];
export const repositoryRoot = join(import.meta.dir, "../..");
export const digest = `sha256:${"c".repeat(64)}`;
export const team: VercelTeam = {
  id: "team_test",
  slug: "test-team",
  name: "Test Team",
  current: true,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

export class FakePrompter implements SetupPrompter {
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

export class FakeReporter implements SetupReporter {
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

export class FakeCli implements VercelSetupCli {
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

export function makeServices(
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

export function standardCapability() {
  return {
    timeoutCapMs: STANDARD_VERCEL_TIMEOUT_CAP_MS,
    timeoutClass: "standard" as const,
    checkedAt: "2026-08-16T13:00:00.000Z",
  };
}

export async function configDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-setup-"));
  roots.push(root);
  return join(root, ".selfbench");
}

import { z } from "zod";
import type { CommandOutputHandler, CommandResult } from "../../process.js";
import {
  commandFailure,
  compareVersion,
  isNotFound,
  MINIMUM_CLI_VERSION,
  paginationValue,
  parseCliVersion,
  parseJson,
  parseLoggedIn,
  uniqueById,
  VERCEL_CLI_PAGE_SIZE,
  vcrBuildArgs,
  vcrLoginArgs,
} from "./cli-helpers.js";
import { ProcessVercelCommandRunner, type VercelCommandRunner } from "./cli-runner.js";
import {
  projectSchema,
  teamSchema,
  type VcrTag,
  type VercelProject,
  type VercelTeam,
  vcrTagSchema,
} from "./cli-types.js";

export class VercelCli {
  readonly #runner: VercelCommandRunner;

  constructor(runner: VercelCommandRunner = new ProcessVercelCommandRunner()) {
    this.#runner = runner;
  }

  async ensureAvailable(): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.#runner.capture(["--version"]);
    } catch (error) {
      throw new Error(
        "Vercel CLI 59.1.3 or newer is required. Install it with: npm install --global vercel@latest",
        { cause: error },
      );
    }
    const version = parseCliVersion(`${result.stdout}\n${result.stderr}`);
    if (result.exitCode !== 0 || !version || compareVersion(version, MINIMUM_CLI_VERSION) < 0) {
      throw new Error(
        "Vercel CLI 59.1.3 or newer is required. Install or update it with: npm install --global vercel@latest",
      );
    }
  }

  async ensureLoggedIn(): Promise<void> {
    const status = await this.#runner.capture(["whoami", "--json", "--non-interactive"]);
    if (status.exitCode === 0 && parseLoggedIn(status.stdout)) {
      return;
    }
    await this.#runner.interactive(["login"]);
    const verified = await this.#runner.capture(["whoami", "--json", "--non-interactive"]);
    if (verified.exitCode !== 0 || !parseLoggedIn(verified.stdout)) {
      throw new Error("Vercel CLI login did not complete; run vercel login and retry setup");
    }
  }

  async listTeams(): Promise<readonly VercelTeam[]> {
    const teams: VercelTeam[] = [];
    const seenPages = new Set<string>();
    let next: string | undefined;
    do {
      const pageKey = next ?? "first";
      if (seenPages.has(pageKey)) {
        throw new Error("Vercel CLI returned a repeated teams pagination cursor");
      }
      seenPages.add(pageKey);
      const args = [
        "teams",
        "list",
        "--json",
        "--limit",
        VERCEL_CLI_PAGE_SIZE,
        "--non-interactive",
      ];
      if (next) {
        args.push("--next", next);
      }
      const result = await this.#runJson(args);
      const parsed = z
        .object({
          teams: z.array(teamSchema),
          pagination: z.object({ next: z.union([z.string(), z.number()]).nullable().optional() }),
        })
        .parse(result);
      teams.push(...parsed.teams);
      next = paginationValue(parsed.pagination.next);
    } while (next);
    return uniqueById(teams);
  }

  async listProjects(teamSlug: string): Promise<readonly VercelProject[]> {
    const projects: VercelProject[] = [];
    const seenPages = new Set<string>();
    let next: string | undefined;
    do {
      const pageKey = next ?? "first";
      if (seenPages.has(pageKey)) {
        throw new Error("Vercel CLI returned a repeated projects pagination cursor");
      }
      seenPages.add(pageKey);
      const args = [
        "project",
        "list",
        "--scope",
        teamSlug,
        "--json",
        "--limit",
        VERCEL_CLI_PAGE_SIZE,
        "--non-interactive",
      ];
      if (next) {
        args.push("--next", next);
      }
      const result = await this.#runJson(args);
      const parsed = z
        .object({
          projects: z.array(projectSchema),
          pagination: z.object({ next: z.union([z.string(), z.number()]).nullable().optional() }),
        })
        .parse(result);
      projects.push(...parsed.projects);
      next = paginationValue(parsed.pagination.next);
    } while (next);
    return uniqueById(projects);
  }

  async createProject(teamSlug: string, projectName: string): Promise<VercelProject> {
    const result = await this.#runner.capture([
      "project",
      "add",
      projectName,
      "--scope",
      teamSlug,
      "--non-interactive",
    ]);
    if (result.exitCode !== 0) {
      throw commandFailure("create Vercel project", result);
    }
    const project = (await this.listProjects(teamSlug)).find(
      ({ name }) => name.toLowerCase() === projectName.toLowerCase(),
    );
    if (!project) {
      throw new Error(
        `Vercel created project ${projectName}, but it was not returned by project list`,
      );
    }
    return project;
  }

  async repositoryExists(input: VcrScope & { readonly repository: string }): Promise<boolean> {
    const result = await this.#runner.capture(
      this.#vcrArgs(
        ["vcr", "inspect", input.repository, "--json"],
        input.teamSlug,
        input.projectId,
      ),
    );
    if (result.exitCode === 0) {
      return true;
    }
    if (isNotFound(result)) {
      return false;
    }
    throw commandFailure("inspect VCR repository", result);
  }

  async createRepository(input: VcrScope & { readonly repository: string }): Promise<void> {
    const result = await this.#runner.capture(
      this.#vcrArgs(["vcr", "add", input.repository, "--json"], input.teamSlug, input.projectId),
    );
    if (result.exitCode !== 0) {
      throw commandFailure("create VCR repository", result);
    }
  }

  async listTags(input: VcrScope & { readonly repository: string }): Promise<readonly VcrTag[]> {
    const tags: VcrTag[] = [];
    const seenPages = new Set<string>();
    let next: string | undefined;
    do {
      const pageKey = next ?? "first";
      if (seenPages.has(pageKey)) {
        throw new Error("Vercel CLI returned a repeated VCR pagination cursor");
      }
      seenPages.add(pageKey);
      const args = this.#vcrArgs(
        ["vcr", "tag", "list", input.repository, "--json", "--limit", VERCEL_CLI_PAGE_SIZE],
        input.teamSlug,
        input.projectId,
      );
      if (next) {
        args.push("--next", next);
      }
      const result = await this.#runJson(args);
      const parsed = z
        .object({
          tags: z.array(vcrTagSchema),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(result);
      tags.push(...parsed.tags);
      next = parsed.nextCursor ?? undefined;
    } while (next);
    return tags;
  }

  async inspectTag(
    input: VcrScope & { readonly repository: string; readonly tag: string },
  ): Promise<VcrTag | undefined> {
    const result = await this.#runner.capture(
      this.#vcrArgs(
        ["vcr", "tag", "inspect", input.repository, input.tag, "--json"],
        input.teamSlug,
        input.projectId,
      ),
    );
    if (result.exitCode === 0) {
      return vcrTagSchema.parse(parseJson(result.stdout, "VCR tag inspect"));
    }
    if (isNotFound(result)) {
      return undefined;
    }
    throw commandFailure("inspect VCR tag", result);
  }

  async buildImage(
    input: VcrScope & {
      readonly repository: string;
      readonly tag: string;
      readonly projectRoot: string;
      readonly onOutput?: CommandOutputHandler;
    },
  ): Promise<void> {
    await this.#run(
      vcrLoginArgs(input.teamSlug, input.projectId),
      "authenticate Docker with VCR",
      input.onOutput,
    );
    await this.#run(vcrBuildArgs(input), "build and publish the VCR image", input.onOutput);
  }

  async #runJson(args: readonly string[]): Promise<unknown> {
    const result = await this.#runner.capture(args);
    if (result.exitCode !== 0) {
      throw commandFailure(`run vercel ${args.slice(0, 2).join(" ")}`, result);
    }
    return parseJson(result.stdout, `vercel ${args.slice(0, 2).join(" ")}`);
  }

  async #run(
    args: readonly string[],
    action: string,
    onOutput?: CommandOutputHandler,
  ): Promise<void> {
    const result = await this.#runner.capture(args, onOutput ? { onOutput } : undefined);
    if (result.exitCode !== 0) {
      throw commandFailure(action, result);
    }
  }

  #vcrArgs(args: string[], teamSlug: string, projectId: string): string[] {
    return [...args, "--project", projectId, "--scope", teamSlug, "--non-interactive"];
  }
}

interface VcrScope {
  readonly teamSlug: string;
  readonly projectId: string;
}

export type { VercelCommandRunner } from "./cli-runner.js";
export type { VcrTag, VercelProject, VercelTeam } from "./cli-types.js";

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { z } from "zod";
import { type CommandOutputHandler, type CommandResult, runCommand } from "../../process.js";

const MINIMUM_CLI_VERSION = [59, 1, 3] as const;
const PAGE_SIZE = "100";

const teamSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  current: z.boolean().optional(),
});

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const vcrTagSchema = z.object({
  tag: z.string().min(1),
  manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i),
  kind: z.enum(["manifest", "index"]).optional(),
  status: z.string().min(1).nullable(),
});

export type VercelTeam = z.infer<typeof teamSchema>;
export type VercelProject = z.infer<typeof projectSchema>;
export type VcrTag = z.infer<typeof vcrTagSchema>;

export interface VercelCommandRunner {
  capture(
    args: readonly string[],
    options?: { readonly onOutput?: CommandOutputHandler },
  ): Promise<CommandResult>;
  interactive(args: readonly string[]): Promise<void>;
}

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
      const args = ["teams", "list", "--json", "--limit", PAGE_SIZE, "--non-interactive"];
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
        PAGE_SIZE,
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
        ["vcr", "tag", "list", input.repository, "--json", "--limit", PAGE_SIZE],
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
      [
        "vcr",
        "login",
        "docker",
        "--project",
        input.projectId,
        "--scope",
        input.teamSlug,
        "--non-interactive",
      ],
      "authenticate Docker with VCR",
      input.onOutput,
    );
    await this.#run(
      [
        "vcr",
        "build",
        "docker",
        input.projectRoot,
        `${input.repository}:${input.tag}`,
        "--project",
        input.projectId,
        "--platform",
        "linux/amd64",
        "--push",
        "--scope",
        input.teamSlug,
        "--non-interactive",
        "--",
        "--file",
        resolve(input.projectRoot, "Dockerfile.sandbox"),
        // Buildx provenance attestations turn this into an OCI index. Vercel
        // Sandbox accepts the single linux/amd64 manifest produced without them.
        "--provenance=false",
      ],
      "build and publish the VCR image",
      input.onOutput,
    );
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

class ProcessVercelCommandRunner implements VercelCommandRunner {
  async capture(
    args: readonly string[],
    options?: { readonly onOutput?: CommandOutputHandler },
  ): Promise<CommandResult> {
    return await runCommand("vercel", args, {
      allowFailure: true,
      ...(options?.onOutput ? { onOutput: options.onOutput } : {}),
    });
  }

  async interactive(args: readonly string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("vercel", args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(
          new Error(
            `vercel ${args.slice(0, 2).join(" ")} exited ${code ?? `after ${signal ?? "signal"}`}`,
          ),
        );
      });
    });
  }
}

function parseCliVersion(value: string): readonly [number, number, number] | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) {
    return undefined;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function parseLoggedIn(value: string): boolean {
  try {
    const parsed = z
      .object({ loggedIn: z.boolean().optional() })
      .passthrough()
      .parse(JSON.parse(value));
    return parsed.loggedIn ?? true;
  } catch {
    return false;
  }
}

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

function paginationValue(value: string | number | null | undefined): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function uniqueById<T extends { readonly id: string }>(values: readonly T[]): readonly T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function isNotFound(result: CommandResult): boolean {
  return /(?:not[_ -]?found|does not exist|\b404\b)/i.test(`${result.stdout}\n${result.stderr}`);
}

function commandFailure(action: string, result: CommandResult): Error {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 1_000);
  return new Error(`${action} failed with exit ${result.exitCode}${detail ? `: ${detail}` : ""}`);
}

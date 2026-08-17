import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256 } from "./hash.js";
import type { CommandOutputHandler } from "./process.js";
import type { SetupPrompter } from "./terminal-prompts.js";
import type { SetupReporter } from "./terminal-reporter.js";
import type { VcrTag } from "./vercel-cli.js";

export const DEFAULT_VCR_REPOSITORY = "selfbench-runtime";

const IMAGE_TAG_PREFIX = "selfbench-";
const IMAGE_PLATFORM = "linux/amd64";
const IMAGE_READINESS_TIMEOUT_MS = 15 * 60 * 1_000;
const IMAGE_POLL_INTERVAL_MS = 5_000;

interface VcrScope {
  readonly teamSlug: string;
  readonly projectId: string;
}

export interface VercelRuntimeImageCli {
  repositoryExists(input: VcrScope & { readonly repository: string }): Promise<boolean>;
  createRepository(input: VcrScope & { readonly repository: string }): Promise<void>;
  listTags(input: VcrScope & { readonly repository: string }): Promise<readonly VcrTag[]>;
  inspectTag(
    input: VcrScope & { readonly repository: string; readonly tag: string },
  ): Promise<VcrTag | undefined>;
  buildImage(
    input: VcrScope & {
      readonly repository: string;
      readonly tag: string;
      readonly projectRoot: string;
      readonly onOutput?: CommandOutputHandler;
    },
  ): Promise<void>;
}

interface RuntimeImageServices {
  readonly cli: VercelRuntimeImageCli;
  readonly prompter: SetupPrompter;
  readonly reporter: SetupReporter;
  readonly sleep: (delayMs: number) => Promise<void>;
}

export interface VercelRuntimeImage {
  readonly repository: string;
  readonly image: string;
  readonly published: boolean;
}

export async function ensureVercelRuntimeImage(input: {
  readonly services: RuntimeImageServices;
  readonly scope: VcrScope;
  readonly projectRoot: string;
  readonly fingerprint: string;
  readonly preferredRepository: string;
}): Promise<VercelRuntimeImage> {
  const { services, scope, projectRoot, fingerprint } = input;
  const tag = `${IMAGE_TAG_PREFIX}${fingerprint}`;
  let repository = input.preferredRepository;

  for (;;) {
    if (!isValidVcrRepositoryName(repository)) {
      throw new Error(`Invalid VCR repository name in saved profile: ${repository}`);
    }
    const exists = await services.cli.repositoryExists({ ...scope, repository });
    if (!exists) {
      try {
        await services.cli.createRepository({ ...scope, repository });
        break;
      } catch (error) {
        // A concurrent setup or a lost success response can leave the repository
        // present. Re-inspect it before treating the operation as failed.
        if (await services.cli.repositoryExists({ ...scope, repository })) {
          continue;
        }
        throw error;
      }
    }

    const tags = await services.cli.listTags({ ...scope, repository });
    const matching = tags.find((candidate) => candidate.tag === tag);
    if (matching) {
      if (
        matching.kind !== "index" &&
        (matching.status === null || ["ready", "preparing"].includes(matching.status))
      ) {
        const ready = await services.reporter.task(
          {
            pending: "Checking the existing runtime image",
            success: "Runtime image ready",
            failure: "Runtime image check failed",
          },
          async () => await waitForReadyTag(services, { ...scope, repository, tag }, matching),
        );
        return {
          repository,
          image: `${repository}@${ready.manifestDigest}`,
          published: false,
        };
      }
      services.reporter.warn(
        `Existing SelfBench image ${repository}:${tag} is ${tagState(matching)}; rebuilding it.`,
      );
      break;
    }

    const compatible =
      tags.length === 0 || tags.some((candidate) => candidate.tag.startsWith(IMAGE_TAG_PREFIX));
    if (compatible) {
      break;
    }
    services.reporter.warn(
      `VCR repository "${repository}" contains unrelated images. SelfBench will not modify it.`,
    );
    repository = await requestVcrRepositoryName(services);
  }

  const ready = await services.reporter.task(
    {
      pending: `Building and publishing the ${IMAGE_PLATFORM} runtime image`,
      success: "Runtime image published",
      failure: "Runtime image publication failed",
    },
    async (onOutput) => {
      await services.cli.buildImage({ ...scope, repository, tag, projectRoot, onOutput });
      return await waitForReadyTag(services, { ...scope, repository, tag });
    },
  );
  return {
    repository,
    image: `${repository}@${ready.manifestDigest}`,
    published: true,
  };
}

export async function vercelRuntimeFingerprint(projectRoot: string): Promise<string> {
  const dockerfile = await readFile(resolve(projectRoot, "Dockerfile.sandbox"), "utf8");
  if (/^\s*(?:ADD|COPY)\s/imu.test(dockerfile)) {
    throw new Error(
      "Dockerfile.sandbox now copies local files; update the VCR fingerprint inputs before publishing",
    );
  }
  return sha256(
    JSON.stringify({
      schemaVersion: 2,
      buildProvenance: false,
      platform: IMAGE_PLATFORM,
      dockerfile,
    }),
  );
}

async function waitForReadyTag(
  services: RuntimeImageServices,
  input: VcrScope & { readonly repository: string; readonly tag: string },
  initial?: VcrTag,
): Promise<VcrTag> {
  const startedAt = Date.now();
  let candidate = initial ?? (await services.cli.inspectTag(input));
  for (;;) {
    if (candidate?.kind === "index") {
      throw new Error(
        `VCR image ${input.repository}:${input.tag} is an OCI index; expected one linux/amd64 manifest`,
      );
    }
    if (candidate?.status === "ready") {
      return candidate;
    }
    if (candidate && candidate.status !== null && candidate.status !== "preparing") {
      throw new Error(
        `VCR image ${input.repository}:${input.tag} entered status ${candidate.status}`,
      );
    }
    if (Date.now() - startedAt >= IMAGE_READINESS_TIMEOUT_MS) {
      throw new Error(`VCR image ${input.repository}:${input.tag} was not ready within 15 minutes`);
    }
    await services.sleep(IMAGE_POLL_INTERVAL_MS);
    candidate = await services.cli.inspectTag(input);
  }
}

function tagState(tag: VcrTag): string {
  if (tag.kind === "index") {
    return "an unsupported OCI index";
  }
  return tag.status ?? "not yet classified by VCR";
}

function isValidVcrRepositoryName(value: string): boolean {
  return /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/.test(value);
}

async function requestVcrRepositoryName(services: RuntimeImageServices): Promise<string> {
  for (;;) {
    const value = (await services.prompter.text("Choose another VCR repository name")).trim();
    if (isValidVcrRepositoryName(value)) {
      return value;
    }
    services.reporter.warn(
      "VCR repository names require lowercase letters or digits separated by dots, underscores, or hyphens.",
    );
  }
}

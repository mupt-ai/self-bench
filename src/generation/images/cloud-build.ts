import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskImageBuilderConfig } from "../../contracts/config/task-images.js";
import type { ArtifactRef } from "../../contracts/index.js";
import { sha256 } from "../../lib/hash.js";
import { tail } from "../../lib/util.js";
import type { BuildFromTask } from "./builder.js";
import { type CloudBuildApi, googleCloudBuild } from "./cloud-build-api.js";
import {
  buildSeconds,
  IMAGE_CONTEXTS,
  mirrorContexts,
  packContexts,
  SNAPSHOT_IN_CONTEXT,
} from "./contexts.js";
import { candidateImageNames } from "./registry.js";

type CloudBuildConfig = Extract<TaskImageBuilderConfig, { kind: "cloud-build" }>;

// Google's own builder images: nothing a build runs before the task's steps comes from Docker Hub.
const FETCHER = "gcr.io/cloud-builders/gcloud";
const DOCKER = "gcr.io/cloud-builders/docker";
const BUILDKIT = "moby/buildkit:v0.17.0";
/** A signed link outlives any wait for a build to start. */
const LINK_TTL_MS = 6 * 60 * 60_000;
/** Allows for the fetch and BuildKit's start ahead of the task's own build limit. */
const OVERHEAD_SECONDS = 30 * 60;

/**
 * Builds a task's two images on Google Cloud Build, as the build's own service account (it may only
 * push task and cache images and read the Docker Hub mirror): the task's setup steps are code from
 * the repository under test, so they never run with the worker's identity.
 *
 * The worker uploads only the two small contexts. The build's first step, before any task code
 * runs, fetches them and the repository snapshot through short-lived signed links, checks both
 * digests, and puts the snapshot where the Dockerfiles copy it from, so each image builds exactly
 * as compiled. Both images then build side by side with BuildKit, which keeps a layer cache per
 * candidate in the cache repository, so a candidate's later checks rebuild only what changed.
 * Each image is pushed by digest, which the step hands back as its output.
 */
export function cloudBuild(
  repository: string,
  config: CloudBuildConfig,
  api: CloudBuildApi | undefined = undefined,
): BuildFromTask {
  const cloud = api ?? googleCloudBuild(config);
  return async (task, store, build, signal) => {
    await mirrorContexts(task.directory, config.mirror);
    const archive = join(task.root, "contexts.tar.gz");
    await packContexts(task.directory, archive, signal);
    const bytes = await readFile(archive);
    const key = `${build.prefix}/image-contexts-${sha256(bytes).slice(0, 16)}.tar.gz`;
    const existing = await store.stat(key);
    const contexts: ArtifactRef = existing
      ? { ...existing, contentType: "application/gzip" }
      : await store.put(key, bytes, "application/gzip");
    const link = async (ref: ArtifactRef) => {
      const url = await store.signedReadUrl?.(ref, LINK_TTL_MS);
      if (!url) throw new Error("Cloud Build needs an artifact store that signs read links");
      return url;
    };
    const names = candidateImageNames(build.runId, build.candidateId);
    const seconds = await buildSeconds(task.directory);
    const steps = buildSteps({
      contexts: { url: await link(contexts), sha256: contexts.sha256 },
      snapshot: { url: await link(build.snapshot), sha256: build.snapshot.sha256 },
      images: {
        agent: `${repository}/${names.agent}`,
        verifier: `${repository}/${names.verifier}`,
      },
      ...(config.cache
        ? {
            cache: {
              agent: `${config.cache}/${names.agent}:cache`,
              verifier: `${config.cache}/${names.verifier}:cache`,
            },
          }
        : {}),
      buildkit: config.mirror ? `${config.mirror}/${BUILDKIT}` : BUILDKIT,
      seconds,
    });
    const finished = await cloud.run(
      { steps, timeout: `${seconds + OVERHEAD_SECONDS}s`, tags: ["selfbench-task-images"] },
      signal,
    );
    if (finished.status === "SUCCESS") {
      const digest = (index: number) => {
        const output = Buffer.from(finished.results?.buildStepOutputs?.[index] ?? "", "base64")
          .toString("utf8")
          .trim();
        if (!/^sha256:[0-9a-f]{64}$/.test(output))
          throw new Error(`Cloud Build ${finished.id} returned no digest for step ${index}`);
        return output;
      };
      return {
        images: {
          agent: `${repository}/${names.agent}@${digest(AGENT_STEP)}`,
          verifier: `${repository}/${names.verifier}@${digest(VERIFIER_STEP)}`,
        },
      };
    }
    const failed = finished.steps?.findIndex((step) =>
      ["FAILURE", "TIMEOUT"].includes(step.status ?? ""),
    );
    const role =
      failed === AGENT_STEP ? "agent" : failed === VERIFIER_STEP ? "verifier" : undefined;
    const step = failed === undefined || failed < 0 ? undefined : finished.steps?.[failed];
    // A step over its own limit may end the build as TIMEOUT rather than FAILURE.
    if (["FAILURE", "TIMEOUT"].includes(finished.status) && role && step) {
      const log = stepLog(await cloud.log(finished.id), step.id ?? role);
      if (step.status === "TIMEOUT")
        return {
          failure: `The ${role} image build exceeded its ${seconds}-second limit.\n\n${log}`,
        };
      if (authoredFailure(log)) return { failure: `--- ${role} image build ---\n${log}` };
    }
    throw new Error(
      `Cloud Build ${finished.id} ended ${finished.status}${finished.statusDetail ? `: ${finished.statusDetail}` : ""}`,
    );
  };
}

const AGENT_STEP = 2;
const VERIFIER_STEP = 3;

/** One task's build: fetch, start BuildKit, then each image (AGENT_STEP and VERIFIER_STEP). */
export function buildSteps(input: {
  readonly contexts: { readonly url: string; readonly sha256: string };
  readonly snapshot: { readonly url: string; readonly sha256: string };
  readonly images: { readonly agent: string; readonly verifier: string };
  readonly cache?: { readonly agent: string; readonly verifier: string };
  readonly buildkit: string;
  readonly seconds: number;
}) {
  const fetch = [
    "set -euo pipefail",
    'curl -fsSL --retry 5 -o /workspace/contexts.tar.gz "$CONTEXTS_URL"',
    'curl -fsSL --retry 5 -o /workspace/snapshot.tar.gz "$SNAPSHOT_URL"',
    'echo "$CONTEXTS_SHA256  /workspace/contexts.tar.gz" | sha256sum -c -',
    'echo "$SNAPSHOT_SHA256  /workspace/snapshot.tar.gz" | sha256sum -c -',
    "mkdir -p /workspace/task",
    "tar -xzf /workspace/contexts.tar.gz -C /workspace/task",
    ...IMAGE_CONTEXTS.map(
      ({ context }) =>
        `cp /workspace/snapshot.tar.gz /workspace/task/${context}/${SNAPSHOT_IN_CONTEXT}`,
    ),
  ];
  const image = (role: "agent" | "verifier", context: string) => {
    const cache = input.cache?.[role];
    return [
      "set -euo pipefail",
      [
        "docker buildx build --builder selfbench --platform linux/amd64 --progress plain",
        ...(cache
          ? [
              `--cache-from type=registry,ref=${cache}`,
              `--cache-to type=registry,ref=${cache},mode=max,image-manifest=true,oci-mediatypes=true`,
            ]
          : []),
        `--output type=image,name=${input.images[role]},push-by-digest=true,name-canonical=true,push=true`,
        `--metadata-file /workspace/${role}.json /workspace/task/${context}`,
      ].join(" "),
      `grep -o '"containerimage.digest": *"sha256:[0-9a-f]*"' /workspace/${role}.json | grep -o 'sha256:[0-9a-f]*' > "$BUILDER_OUTPUT/output"`,
    ];
  };
  const script = (lines: readonly string[]) => ["-c", literal(lines.join("\n"))];
  return [
    {
      id: "fetch",
      name: FETCHER,
      entrypoint: "bash",
      args: script(fetch),
      env: [
        `CONTEXTS_URL=${input.contexts.url}`,
        `CONTEXTS_SHA256=${input.contexts.sha256}`,
        `SNAPSHOT_URL=${input.snapshot.url}`,
        `SNAPSHOT_SHA256=${input.snapshot.sha256}`,
      ].map(literal),
    },
    {
      id: "buildkit",
      name: DOCKER,
      entrypoint: "bash",
      args: script([
        `docker buildx create --name selfbench --driver docker-container --driver-opt image=${input.buildkit} --bootstrap`,
      ]),
      waitFor: ["-"],
    },
    ...IMAGE_CONTEXTS.map(({ role, context }) => ({
      id: role,
      name: DOCKER,
      entrypoint: "bash",
      args: script(image(role, context)),
      waitFor: ["fetch", "buildkit"],
      timeout: `${input.seconds}s`,
    })),
  ];
}

/** Cloud Build substitutes `$NAME` in a build's strings; `$$` is a literal `$`. */
function literal(text: string): string {
  return text.replace(/\$/g, () => "$$");
}

/** A Dockerfile step of the task's own failed, or its base image does not exist: the author's. */
function authoredFailure(log: string): boolean {
  return /did not complete successfully: exit code|manifest unknown|name unknown/i.test(log);
}

/** One step's lines of a build log (`Step #2 - "agent": …`), without the prefix, at most ~12 KB. */
export function stepLog(log: string, id: string): string {
  const prefix = new RegExp(`^Step #\\d+ - "${id}": ?`);
  const lines = log
    .split("\n")
    .filter((line) => prefix.test(line))
    .map((line) => line.replace(prefix, ""));
  return tail(lines.join("\n").trim(), 12_000);
}

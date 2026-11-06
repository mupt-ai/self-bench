import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudBuildApi, FinishedBuild } from "../../src/generation/images/cloud-build-api.js";
import { withLiveApt } from "../../src/generation/images/live-apt.js";
import type { RegistryAccess } from "../../src/generation/images/registry.js";
import { LIVE_APT_SOURCES } from "../../src/generation/task/live-apt.js";
import { agentDockerfile, verifierDockerfile } from "../../src/generation/task/render.js";
import { runCommand } from "../../src/lib/process.js";

const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/tasks";
const DIGEST = `sha256:${"a".repeat(64)}`;
const BUILT = `sha256:${"b".repeat(64)}`;
const images = {
  agent: `${REPOSITORY}/batch-1/task-1/agent@${DIGEST}`,
  verifier: `${REPOSITORY}/batch-1/task-1/verifier@${DIGEST}`,
};
const env = {
  SELFBENCH_TASK_IMAGE_REPOSITORY: REPOSITORY,
  SELFBENCH_TASK_IMAGE_BUILDER: "cloud-build",
  SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT: "builder@selfbench-test.iam.gserviceaccount.com",
  SELFBENCH_CLOUD_BUILD_LOGS_BUCKET: "builds",
};
const PINNED = `FROM node:22-bookworm
RUN sed -i 's|http://deb.debian.org/debian|https://snapshot.debian.org/archive/debian/20260923T000000Z|g' /etc/apt/sources.list.d/debian.sources
`;

let task: string | undefined;
afterEach(async () => {
  if (task) await rm(task, { recursive: true, force: true });
  task = undefined;
});

async function taskWith(agent: string, verifier: string): Promise<string> {
  task = await mkdtemp(join(tmpdir(), "live-apt-"));
  await mkdir(join(task, "environment"));
  await mkdir(join(task, "tests"));
  await writeFile(join(task, "environment/Dockerfile"), agent);
  await writeFile(join(task, "tests/Dockerfile"), verifier);
  return task;
}

/** Artifact Registry with the tags in `tagged`, and Cloud Build that records and answers builds. */
function fakes(tagged: Record<string, string> = {}, status = "SUCCESS") {
  const builds: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const registry: RegistryAccess = {
    token: async () => "token",
    fetch: async (input) => {
      const tag = decodeURIComponent(String(input).split("/tags/")[1] ?? "");
      const digest = tagged[tag];
      return digest
        ? Response.json({
            version: `projects/p/locations/l/repositories/r/packages/x/versions/${digest}`,
          })
        : new Response("", { status: 404 });
    },
  };
  const cloud: CloudBuildApi = {
    async run(build, signal) {
      builds.push(build);
      signals.push(signal);
      return {
        id: "build-1",
        status,
        results: { buildStepOutputs: [Buffer.from(`${BUILT}\n`).toString("base64")] },
      } satisfies FinishedBuild;
    },
    log: async () => "",
  };
  return { registry, cloud, builds, signals };
}

test("an E2B task whose Dockerfile pins apt to a snapshot gets an image with apt on its live mirrors", async () => {
  const directory = await taskWith(PINNED, "FROM node:22-bookworm\n");
  const { registry, cloud, builds, signals } = fakes();
  const stop = new AbortController();
  const live = await withLiveApt(directory, images, "e2b", env, {
    cloud,
    registry,
    signal: stop.signal,
  });
  // Cancelling the activity that asked for it cancels the build.
  expect(signals).toEqual([stop.signal]);
  expect(live).toEqual({
    agent: `${REPOSITORY}/batch-1/task-1/agent-live-apt@${BUILT}`,
    verifier: images.verifier,
  });
  const steps = (builds[0]?.steps ?? []) as { args: string[] }[];
  const script = steps[0]?.args[1] ?? "";
  // Cloud Build reads `$NAME` as a substitution, so every `$` the script means is doubled.
  const meant = script.replaceAll("$$", "$");
  expect(meant).toContain(`FROM ${images.agent}\nUSER root\nRUN ${LIVE_APT_SOURCES}\n`);
  expect(meant).toContain(
    `docker push ${REPOSITORY}/batch-1/task-1/agent-live-apt:from-${"a".repeat(64)}`,
  );
  expect(script).not.toMatch(/(?<!\$)\$(?!\$)/);
});

test("an image built before is found by its tag, and nothing else changes", async () => {
  const directory = await taskWith(PINNED, PINNED);
  const tagged = { [`from-${"a".repeat(64)}`]: BUILT };
  const { registry, cloud, builds } = fakes(tagged);
  expect(await withLiveApt(directory, images, "e2b", env, { cloud, registry })).toEqual({
    agent: `${REPOSITORY}/batch-1/task-1/agent-live-apt@${BUILT}`,
    verifier: `${REPOSITORY}/batch-1/task-1/verifier-live-apt@${BUILT}`,
  });
  expect(builds).toEqual([]);
  // Other providers make no templates; a task compiled since restores its own mirrors.
  expect(await withLiveApt(directory, images, "modal", env, { cloud, registry })).toBe(images);
  const compiled = await taskWith(agentDockerfile(PINNED), verifierDockerfile(PINNED));
  expect(await withLiveApt(compiled, images, "e2b", env, { cloud, registry })).toEqual(images);
  expect(builds).toEqual([]);
});

test("a build that fails says which image could not be fixed, unless another build pushed it", async () => {
  const directory = await taskWith(PINNED, "FROM node:22-bookworm\n");
  const failing = fakes({}, "FAILURE");
  await expect(
    withLiveApt(directory, images, "e2b", env, {
      cloud: failing.cloud,
      registry: failing.registry,
    }),
  ).rejects.toThrow(
    `Cloud Build build-1 could not point ${images.agent} at apt's live mirrors (FAILURE)`,
  );
  // Tags are immutable: a build that lost the race to push uses the image that won.
  const tagged: Record<string, string> = {};
  const raced = fakes(tagged, "FAILURE");
  const run = raced.cloud.run;
  raced.cloud.run = async (build, signal) => {
    tagged[`from-${"a".repeat(64)}`] = BUILT;
    return run(build, signal);
  };
  expect(
    (
      await withLiveApt(directory, images, "e2b", env, {
        cloud: raced.cloud,
        registry: raced.registry,
      })
    )?.agent,
  ).toBe(`${REPOSITORY}/batch-1/task-1/agent-live-apt@${BUILT}`);
});

test("the live mirrors replace Debian and Ubuntu snapshots, and nothing else", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-apt-sources-"));
  try {
    const sources = join(root, "debian.sources");
    await writeFile(
      sources,
      [
        "URIs: https://snapshot.debian.org/archive/debian/20260401T000000Z/",
        "URIs: http://snapshot.debian.org/archive/debian-security/20260923T000000Z",
        "deb https://snapshot.ubuntu.com/ubuntu/20240301T000000Z jammy main",
        "URIs: http://deb.debian.org/debian",
        "",
      ].join("\n"),
    );
    const script = LIVE_APT_SOURCES.replace(
      "/etc/apt/sources.list /etc/apt/sources.list.d/*",
      sources,
    );
    const result = await runCommand("sh", ["-euc", script]);
    expect(result.exitCode).toBe(0);
    expect((await readFile(sources, "utf8")).split("\n")).toEqual([
      "URIs: http://deb.debian.org/debian",
      "URIs: http://deb.debian.org/debian-security",
      "deb http://archive.ubuntu.com/ubuntu jammy main",
      "URIs: http://deb.debian.org/debian",
      "",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

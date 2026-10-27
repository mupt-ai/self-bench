import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { taskImageBuilder } from "../../src/generation/images/builder.js";
import { buildSteps, stepLog } from "../../src/generation/images/cloud-build.js";
import type { CloudBuildApi, FinishedBuild } from "../../src/generation/images/cloud-build-api.js";
import { mirrorDockerHub } from "../../src/generation/images/contexts.js";
import { gzippedTar, tarEntries } from "../support/tar.js";

const REPOSITORY = "us-central1-docker.pkg.dev/p/selfbench-tasks";
const MIRROR = "us-central1-docker.pkg.dev/p/dockerhub";
const NODE = `node:22@sha256:${"1".repeat(64)}`;
const config = {
  kind: "cloud-build" as const,
  project: "p",
  region: "us-central1",
  serviceAccount: "builder@p.iam.gserviceaccount.com",
  logsBucket: "p-task-builds",
  cache: "us-central1-docker.pkg.dev/p/selfbench-task-cache",
  mirror: MIRROR,
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A store that signs read links, holding one attempt's gate task and snapshot. */
async function attempt() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-cloud-build-"));
  roots.push(root);
  const local = new LocalArtifactStore(root);
  const store = Object.assign(local, {
    signedReadUrl: async (ref: { uri: string }) =>
      `https://signed.test/${ref.uri.split("/").pop()}`,
  });
  const prefix = "runs/run-1/verify/cand/authoring-round-1/compile/attempt-1";
  const gate = await store.put(
    `${prefix}/gate-task.tar.gz`,
    await gzippedTar({
      "harbor-task/task.toml":
        "[environment]\nbuild_timeout_sec = 900.0\n[verifier.environment]\nbuild_timeout_sec = 1200.0\n",
      "harbor-task/environment/Dockerfile": `FROM ${NODE}\nCOPY repo.tar.gz /tmp/repo.tar.gz\n`,
      "harbor-task/tests/Dockerfile": `FROM ghcr.io/org/base@sha256:${"2".repeat(64)}\n`,
      "harbor-task/tests/test.sh": "hidden tests",
    }),
    "application/gzip",
  );
  const snapshot = await store.put(
    `${prefix}/repo.tar.gz`,
    Buffer.from("repo"),
    "application/gzip",
  );
  return { store, build: { runId: "run-1", candidateId: "cand", gate, snapshot, prefix } };
}

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const output = (text: string) => Buffer.from(text).toString("base64");

/** Cloud Build ending every build as `finished`, with `log` as its log. */
function cloud(finished: Omit<FinishedBuild, "id">, log = "") {
  const runs: Record<string, unknown>[] = [];
  const api: CloudBuildApi = {
    run: async (build) => {
      runs.push(build);
      return { id: "build-1", ...finished };
    },
    log: async () => log,
  };
  return { api, runs };
}

async function build(finished: Omit<FinishedBuild, "id">, log = "") {
  const { store, build: input } = await attempt();
  const { api, runs } = cloud(finished, log);
  const builder = taskImageBuilder({ repository: REPOSITORY, builder: config }, { cloud: api });
  if (!builder) throw new Error("Missing builder");
  const result = builder.build(store, input, new AbortController().signal);
  return { result, runs, store, input };
}

test("Docker Hub base images are pulled through the mirror by the same digest", () => {
  expect(mirrorDockerHub(`FROM ${NODE}\nRUN true\n`, MIRROR)).toBe(
    `FROM ${MIRROR}/library/node:22@${digest("1")}\nRUN true\n`,
  );
  expect(
    mirrorDockerHub(`FROM --platform=linux/amd64 owner/img@${digest("3")} AS base`, MIRROR),
  ).toBe(`FROM --platform=linux/amd64 ${MIRROR}/owner/img@${digest("3")} AS base`);
  // Other registries, unpinned names and stage names are left alone.
  const other = `FROM ghcr.io/org/base@${digest("2")}\nFROM node:22\nFROM base\n`;
  expect(mirrorDockerHub(other, MIRROR)).toBe(other);
});

test("a build uploads only the mirrored contexts and returns both images by digest", async () => {
  const { result, runs, store, input } = await build({
    status: "SUCCESS",
    results: { buildStepOutputs: ["", "", output(`${digest("a")}\n`), output(digest("b"))] },
  });
  expect(await result).toEqual({
    images: {
      agent: `${REPOSITORY}/run-1/cand/agent@${digest("a")}`,
      verifier: `${REPOSITORY}/run-1/cand/verifier@${digest("b")}`,
    },
  });
  // Both images build within the task's own longest build limit, plus the fetch.
  expect(runs[0]?.timeout).toBe(`${1200 + 1800}s`);
  const [contexts] = (await store.list(input.prefix)).filter((entry) =>
    entry.key.includes("image-contexts-"),
  );
  if (!contexts) throw new Error("Missing uploaded contexts");
  const entries = await tarEntries(Buffer.from((await store.getByKey(contexts.key)) ?? []));
  expect(entries.map((entry) => entry.path).sort()).toEqual([
    "environment/",
    "environment/Dockerfile",
    "tests/",
    "tests/Dockerfile",
    "tests/test.sh",
  ]);
  expect(entries.find((entry) => entry.path === "environment/Dockerfile")?.text).toStartWith(
    `FROM ${MIRROR}/library/node:22@${digest("1")}\n`,
  );
});

test("a failing Dockerfile step or a build over its limit is the author's; anything else retries", async () => {
  const log = [
    'Step #2 - "agent": #9 [4/6] RUN /opt/selfbench-environment/setup.sh',
    'Step #2 - "agent": ERROR: failed to solve: process "/bin/sh -c setup.sh" did not complete successfully: exit code: 2',
  ].join("\n");
  const steps = [
    { id: "fetch", status: "SUCCESS" },
    { id: "buildkit", status: "SUCCESS" },
  ];
  const failed = await build(
    {
      status: "FAILURE",
      steps: [...steps, { id: "agent", status: "FAILURE" }, { id: "verifier" }],
    },
    log,
  );
  const failure = await failed.result;
  expect(failure).toEqual({ failure: expect.stringContaining("did not complete successfully") });
  expect(JSON.stringify(failure)).not.toContain("Step #2");
  const slow = await build({
    status: "FAILURE",
    steps: [...steps, { id: "agent", status: "SUCCESS" }, { id: "verifier", status: "TIMEOUT" }],
  });
  expect(await slow.result).toEqual({
    failure: expect.stringContaining("verifier image build exceeded its 1200-second limit"),
  });
  const pushed = await build(
    { status: "FAILURE", steps: [...steps, { id: "agent", status: "FAILURE" }] },
    'Step #2 - "agent": ERROR: failed to push: unexpected status 503',
  );
  await expect(pushed.result).rejects.toThrow("Cloud Build build-1 ended FAILURE");
  const lost = await build({ status: "INTERNAL_ERROR", statusDetail: "worker lost" });
  await expect(lost.result).rejects.toThrow("ended INTERNAL_ERROR: worker lost");
});

test("the steps escape Cloud Build substitutions and keep a cache per candidate", () => {
  const steps = buildSteps({
    contexts: { url: "https://signed.test/contexts?X-Goog-Signature=abc", sha256: "c".repeat(64) },
    snapshot: { url: "https://signed.test/repo", sha256: "d".repeat(64) },
    images: { agent: `${REPOSITORY}/run/cand/agent`, verifier: `${REPOSITORY}/run/cand/verifier` },
    cache: {
      agent: `${config.cache}/run/cand/agent:cache`,
      verifier: `${config.cache}/run/cand/verifier:cache`,
    },
    buildkit: `${MIRROR}/moby/buildkit:v0.17.0`,
    seconds: 1200,
  });
  expect(steps.map((step) => step.id)).toEqual(["fetch", "buildkit", "agent", "verifier"]);
  const fetch = steps[0]?.args[1] ?? "";
  // No `$NAME` reaches Cloud Build unescaped; the shell sees each as written.
  expect(fetch).not.toMatch(/(^|[^$])\$[A-Z_{]/);
  expect(fetch).toContain("$$CONTEXTS_URL");
  expect(fetch).toContain("sha256sum -c -");
  expect(fetch).toContain("cp /workspace/snapshot.tar.gz /workspace/task/tests/repo.tar.gz");
  const agent = steps[2];
  expect(agent?.waitFor).toEqual(["fetch", "buildkit"]);
  expect(agent && "timeout" in agent ? agent.timeout : undefined).toBe("1200s");
  expect(agent?.args[1]).toContain(
    `--cache-from type=registry,ref=${config.cache}/run/cand/agent:cache`,
  );
  expect(agent?.args[1]).toContain(
    `--output type=image,name=${REPOSITORY}/run/cand/agent,push-by-digest=true`,
  );
  expect(agent?.args[1]).toContain('"$$BUILDER_OUTPUT/output"');
  expect(steps[1]?.args[1]).toContain(`image=${MIRROR}/moby/buildkit:v0.17.0`);
});

test("a step's log is its own lines without Cloud Build's prefix", () => {
  const log = [
    'Step #2 - "agent": #7 [3/5] RUN /opt/selfbench-environment/setup.sh',
    'Step #3 - "verifier": #7 DONE',
    'Step #2 - "agent": ERROR: process "/bin/sh -c setup.sh" did not complete successfully: exit code: 1',
  ].join("\n");
  expect(stepLog(log, "agent")).toBe(
    '#7 [3/5] RUN /opt/selfbench-environment/setup.sh\nERROR: process "/bin/sh -c setup.sh" did not complete successfully: exit code: 1',
  );
});

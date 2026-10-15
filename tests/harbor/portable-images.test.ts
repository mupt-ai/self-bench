import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import { taskImagesSchema } from "../../src/contracts/task.js";
import {
  portableBuilderConfigured,
  portableBuilderEnvironment,
  preparePortableImages,
} from "../../src/generation/pipeline/portable-images.js";
import { pinnedImageKwargs } from "../../src/harnesses/harbor/pinned-images.js";
import { runCommand } from "../../src/lib/process.js";

const repository = "us-central1-docker.pkg.dev/p/tasks";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("portable images require both digests and never become Modal cache pins", () => {
  const registry = {
    agent: `${repository}/task@sha256:${"a".repeat(64)}`,
    verifier: `${repository}/task@sha256:${"b".repeat(64)}`,
  };
  const images = taskImagesSchema.parse({ provider: "oci", registry });
  expect(pinnedImageKwargs(images)).toEqual({});
  expect(
    taskImagesSchema.safeParse({ provider: "oci", registry: { agent: registry.agent } }).success,
  ).toBe(false);
  expect(taskImagesSchema.parse({ provider: "modal", agent: "im-legacy" })).toEqual({
    provider: "modal",
    agent: "im-legacy",
  });
});

test("builder credentials are independent of verification credentials and contain no model or cloud secrets", () => {
  const env = portableBuilderEnvironment({
    SELFBENCH_MANAGED_MODAL_TOKEN_ID: "platform-id",
    SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "platform-secret",
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "platform-env",
    MODAL_TOKEN_ID: "user-id",
    MODAL_TOKEN_SECRET: "user-secret",
    E2B_API_KEY: "e2b",
    GH_TOKEN: "github",
    GOOGLE_APPLICATION_CREDENTIALS: "/secret.json",
    OPENROUTER_API_KEY: "model",
  });
  expect(env.MODAL_TOKEN_ID).toBe("platform-id");
  expect(env.MODAL_ENVIRONMENT).toBe("platform-env");
  for (const key of [
    "E2B_API_KEY",
    "GH_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENROUTER_API_KEY",
  ])
    expect(env[key]).toBeUndefined();
  expect(() => portableBuilderEnvironment({})).toThrow("configured Modal image builder");
  // Verification only takes the portable path when a builder exists, so prod without one still
  // accepts tasks instead of failing each of them.
  expect(portableBuilderConfigured({})).toBe(false);
  expect(portableBuilderConfigured({ MODAL_TOKEN_ID: "id" })).toBe(false);
  expect(portableBuilderConfigured({ MODAL_TOKEN_ID: "id", MODAL_TOKEN_SECRET: "s" })).toBe(true);
  // The dedicated builder wins, and its pair is never mixed with another account's.
  const dedicated = portableBuilderEnvironment({
    SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_ID: "builder-id",
    SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_SECRET: "builder-secret",
    SELFBENCH_TASK_IMAGE_BUILDER_MODAL_ENVIRONMENT: "builder-env",
    SELFBENCH_MANAGED_MODAL_TOKEN_ID: "platform-id",
    SELFBENCH_MANAGED_MODAL_TOKEN_SECRET: "platform-secret",
    SELFBENCH_MANAGED_MODAL_ENVIRONMENT: "platform-env",
  });
  expect([
    dedicated.MODAL_TOKEN_ID,
    dedicated.MODAL_TOKEN_SECRET,
    dedicated.MODAL_ENVIRONMENT,
  ]).toEqual(["builder-id", "builder-secret", "builder-env"]);
  const halfPair = portableBuilderEnvironment({
    SELFBENCH_TASK_IMAGE_BUILDER_MODAL_TOKEN_ID: "builder-id",
    MODAL_TOKEN_ID: "worker-id",
    MODAL_TOKEN_SECRET: "worker-secret",
  });
  expect([halfPair.MODAL_TOKEN_ID, halfPair.MODAL_TOKEN_SECRET]).toEqual([
    "worker-id",
    "worker-secret",
  ]);
});

test("builds agent and verifier in separate contexts and records OCI digests before verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfbench-portable-test-"));
  roots.push(root);
  const store = new LocalArtifactStore(join(root, "store"));
  const source = join(root, "source");
  for (const context of ["environment", "tests"]) {
    await mkdir(join(source, "harbor-task", context), { recursive: true });
    await writeFile(
      join(source, "harbor-task", context, "Dockerfile"),
      `FROM base\nENV ROLE=${context}\n`,
    );
  }
  const archive = join(root, "source.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", source, "harbor-task"]);
  const bundle = await store.putFile(
    "runs/run/verify/task/harbor-task.tar.gz",
    archive,
    "application/gzip",
  );
  const task = {
    candidateId: "c",
    taskId: "task",
    definition: bundle,
    sourceBundle: bundle,
    bundle,
  };
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "harbor"), "#!/usr/bin/python3\n");
  await chmod(join(bin, "harbor"), 0o700);
  const contexts: string[] = [];
  const result = await preparePortableImages(
    store,
    task,
    repository,
    new AbortController().signal,
    {
      env: { PATH: bin, MODAL_TOKEN_ID: "builder", MODAL_TOKEN_SECRET: "builder-secret" },
      token: async () => "worker-only-token",
      configFor: async () => ({ Env: [] }),
      command: (async (_command, args, options) => {
        const context = args[1] ?? "";
        contexts.push(context.split("/").at(-1) ?? "");
        expect(await readFile(join(context, "Dockerfile"), "utf8")).toContain(
          `ROLE=${contexts.at(-1)}`,
        );
        expect(await readFile(options?.env?.SELFBENCH_EXPORT_TOKEN_FILE ?? "", "utf8")).toBe(
          "worker-only-token",
        );
        expect(args.join(" ")).not.toContain("worker-only-token");
        return {
          exitCode: 0,
          stdout: `sha256:${String(contexts.length).repeat(64)}\n`,
          stderr: "",
        };
      }) as typeof runCommand,
    },
  );
  expect(contexts).toEqual(["environment", "tests"]);
  expect(result.bundle).toEqual(task.bundle);
  expect(result.images?.provider).toBe("oci");
  expect(result.images?.registry?.agent).toBe(
    `${repository}/task-${bundle.sha256}@sha256:${"1".repeat(64)}`,
  );
  expect(result.images?.registry?.verifier).toBe(
    `${repository}/task-${bundle.sha256}@sha256:${"2".repeat(64)}`,
  );
  expect(await preparePortableImages(store, result, repository, new AbortController().signal)).toBe(
    result,
  );
});

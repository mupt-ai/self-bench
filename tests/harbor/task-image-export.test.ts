import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/artifacts/local.js";
import type { AuthoredTask } from "../../src/contracts/index.js";
import {
  dockerfileImageConfig,
  exportTaskImages,
} from "../../src/generation/pipeline/task-image-export.js";
import { runCommand } from "../../src/lib/process.js";

const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-task-image-export-"));
  roots.push(root);
  return root;
}

test("an image keeps its base's config, then each ENV, USER and WORKDIR in order", async () => {
  const dockerfile = [
    `FROM python:3.13@sha256:${"a".repeat(64)}`,
    "USER root",
    'ENV CARGO_HOME="/usr/local/cargo" CI=1',
    // Docker substitutes both spellings of a variable.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Dockerfile's ${PATH}, not a template
    'ENV PATH="$CARGO_HOME/bin:${PATH}"',
    "ENV LEGACY form with spaces",
    "RUN echo \\",
    "    ENV NOT_AN_INSTRUCTION=1",
    "ENV HOME=/home/agent",
    "USER agent",
    "WORKDIR /app",
  ].join("\n");
  const config = await dockerfileImageConfig(dockerfile, async (image) => {
    expect(image).toBe(`python:3.13@sha256:${"a".repeat(64)}`);
    return { Env: ["PATH=/usr/local/bin:/usr/bin", "PYTHON_VERSION=3.13.13"], WorkingDir: "/" };
  });
  expect(config).toEqual({
    Env: [
      "PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/bin",
      "PYTHON_VERSION=3.13.13",
      "CARGO_HOME=/usr/local/cargo",
      "CI=1",
      "LEGACY=form with spaces",
      "HOME=/home/agent",
    ],
    User: "agent",
    WorkingDir: "/app",
  });
});

test("a multi-stage Dockerfile's image has its last stage's config", async () => {
  const dockerfile = [
    "FROM golang:1.23@sha256:" + "b".repeat(64) + " AS build",
    "ENV CGO_ENABLED=0",
    "WORKDIR /src",
    `FROM debian@sha256:${"c".repeat(64)}`,
    "ENV APP=1",
    "FROM build AS test",
    "USER tester",
  ].join("\n");
  const configs: Record<string, { Env: string[] }> = {
    [`golang:1.23@sha256:${"b".repeat(64)}`]: { Env: ["PATH=/usr/local/go/bin:/usr/bin"] },
    [`debian@sha256:${"c".repeat(64)}`]: { Env: ["PATH=/usr/bin"] },
  };
  expect(
    await dockerfileImageConfig(dockerfile, async (image) => configs[image] ?? { Env: [] }),
  ).toEqual({
    Env: ["PATH=/usr/local/go/bin:/usr/bin", "CGO_ENABLED=0"],
    User: "tester",
    WorkingDir: "/src",
  });
});

test("an accepted task's Modal images are exported beside its pins", async () => {
  const root = await temporary();
  const store = new LocalArtifactStore(join(root, "store"));
  const source = join(root, "source", "harbor-task");
  for (const [context, user] of [
    ["environment", "agent"],
    ["tests", "root"],
  ] as const) {
    await mkdir(join(source, context), { recursive: true });
    await writeFile(
      join(source, context, "Dockerfile"),
      `FROM base@sha256:${"a".repeat(64)}\nENV ROLE=${context}\nUSER ${user}\nWORKDIR /app\n`,
    );
  }
  const archive = join(root, "task.tar.gz");
  await runCommand("tar", ["-czf", archive, "-C", join(root, "source"), "harbor-task"]);
  const bundle = await store.putFile("compile/harbor-task.tar.gz", archive, "application/gzip");
  const task: AuthoredTask = {
    candidateId: "cand-1",
    taskId: "Task_1",
    definition: bundle,
    sourceBundle: bundle,
    bundle,
    images: { provider: "modal", agent: "im-Agent1", verifier: "im-Verifier1" },
  };
  const calls: { args: readonly string[]; env: NodeJS.ProcessEnv; token: string }[] = [];
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "harbor"), "#!/usr/bin/python3\n");
  await chmod(join(bin, "harbor"), 0o700);

  const exported = await exportTaskImages(store, task, {
    repository: REPOSITORY,
    env: { PATH: bin, MODAL_TOKEN_ID: "modal" },
    token: async () => "push-token",
    signal: new AbortController().signal,
    configFor: async () => ({ Env: ["PATH=/usr/bin"] }),
    command: (async (
      _command: string,
      args: readonly string[],
      options?: { env?: NodeJS.ProcessEnv },
    ) => {
      const env = options?.env ?? {};
      calls.push({
        args,
        env,
        token: await readFile(env.SELFBENCH_EXPORT_TOKEN_FILE ?? "", "utf8"),
      });
      const digit = args[1] === "im-Agent1" ? "1" : "2";
      return { exitCode: 0, stdout: `pushing\nsha256:${digit.repeat(64)}\n`, stderr: "" };
    }) as typeof runCommand,
  });

  expect(exported.images).toEqual({
    provider: "modal",
    agent: "im-Agent1",
    verifier: "im-Verifier1",
    registry: {
      agent: `${REPOSITORY}/task-1@sha256:${"1".repeat(64)}`,
      verifier: `${REPOSITORY}/task-1@sha256:${"2".repeat(64)}`,
    },
  });
  expect(calls.map((call) => call.args.slice(1, 3))).toEqual([
    ["im-Agent1", "task-1"],
    ["im-Verifier1", "task-1"],
  ]);
  for (const [index, call] of calls.entries()) {
    expect(call.args[0]?.endsWith("selfbench_export.py")).toBe(true);
    expect(call.env.MODAL_TOKEN_ID).toBe("modal");
    expect(call.token).toBe("push-token");
    expect(call.env.SELFBENCH_EXPORT_REGISTRY).toBe(
      "https://us-central1-docker.pkg.dev/v2/selfbench-test/selfbench-tasks",
    );
    const role = index === 0 ? ["environment", "agent"] : ["tests", "root"];
    expect(JSON.parse(call.env.SELFBENCH_EXPORT_CONFIG ?? "")).toEqual({
      Env: ["PATH=/usr/bin", `ROLE=${role[0]}`],
      User: role[1],
      WorkingDir: "/app",
    });
  }
  // A task already exported, or never pinned, is left as it is.
  expect(await exportTaskImages(store, exported, {} as never)).toBe(exported);
});

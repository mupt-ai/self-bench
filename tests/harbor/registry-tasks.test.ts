import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registryReference } from "../../src/contracts/harbor-registry.js";
import {
  checkRegistryTask,
  downloadRegistryTasks,
} from "../../src/harnesses/harbor/registry-tasks.js";
import { UnsafeHarborTaskError } from "../../src/harnesses/harbor/task-safety.js";
import { runCommand } from "../../src/lib/process.js";
import { fakeHarbor, harborTaskToml, publishedTask } from "../support/harbor-registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-registry-task-"));
  roots.push(root);
  return root;
}

async function taskDirectory(files: Record<string, string>): Promise<string> {
  const root = await temporary();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const harborEnv = { PATH: "/usr/bin", HOME: "/home/node", MODAL_TOKEN_SECRET: "as-secret" };

test("registry references name an org's task or dataset, at latest unless a ref is given", () => {
  expect(registryReference("terminal-bench/terminal-bench-2")).toBe(
    "terminal-bench/terminal-bench-2@latest",
  );
  expect(registryReference("snorkel-ai/senior-swe-bench-v2026.06@3")).toBe(
    "snorkel-ai/senior-swe-bench-v2026.06@3",
  );
  const digest = `sha256:${"f".repeat(64)}`;
  expect(registryReference(`hello-world/hello-world@${digest}`)).toBe(
    `hello-world/hello-world@${digest}`,
  );
  for (const invalid of [
    "hello-world",
    "--registry-url=https://example.com/x",
    "-o/name",
    "org/-name",
    "../org/name",
    "org/name/extra",
    "org/name@",
    "org/name@-x",
    "org/name with space",
    "org/name;rm -rf /",
    "https://example.com/org/name",
  ])
    expect(() => registryReference(invalid)).toThrow("org/name@ref");
});

test("a download runs Harbor with only PATH and a HOME of its own, and reads each task from its cache", async () => {
  const harbor = fakeHarbor(
    {
      "org/dataset@latest": [
        publishedTask("org/zeta", {}, "b".repeat(64)),
        publishedTask("other/alpha", {}, "c".repeat(64)),
      ],
    },
    runCommand,
  );
  const root = await temporary();
  const tasks = await downloadRegistryTasks("org/dataset", root, {
    command: harbor.command,
    path: "/usr/bin",
  });
  expect(harbor.calls).toEqual([
    {
      args: ["download", "org/dataset@latest", "--cache"],
      env: { PATH: "/usr/bin", HOME: join(root, "home"), HARBOR_TELEMETRY: "off" },
    },
  ]);
  expect(tasks.map(({ name, digest }) => ({ name, digest }))).toEqual([
    { name: "org/zeta", digest: `sha256:${"b".repeat(64)}` },
    { name: "other/alpha", digest: `sha256:${"c".repeat(64)}` },
  ]);
  const first = tasks[0];
  if (!first) throw new Error("Missing task");
  expect(await readFile(join(first.directory, "task.toml"), "utf8")).toBe(
    harborTaskToml("org/zeta"),
  );
});

test("a download that finds no package tasks, or tasks outside the package cache, is refused", async () => {
  const empty = fakeHarbor({ "org/empty@latest": [] }, runCommand);
  await expect(
    downloadRegistryTasks("org/empty", await temporary(), { command: empty.command, path: "" }),
  ).rejects.toThrow("has no tasks");
  const legacy = fakeHarbor({ "org/legacy@latest": [publishedTask("org/task")] }, async () => {
    throw new Error("not run");
  });
  const command: typeof runCommand = async (program, args, options = {}) => {
    const result = await legacy.command(program, args, options);
    await mkdir(join(options.env?.HOME ?? "", ".cache", "harbor", "tasks", "git-task"));
    return result;
  };
  await expect(
    downloadRegistryTasks("org/legacy", await temporary(), { command, path: "" }),
  ).rejects.toThrow("outside Harbor's package registry");
});

test("a registry task is checked as published and left unchanged, with its own limits", async () => {
  const published: Record<string, string> = {
    ...publishedTask("terminal-bench/build").files,
    "task.toml": harborTaskToml("terminal-bench/build", 'docker_image = "someone/build:1"\n'),
  };
  const directory = await taskDirectory(published);
  // Build, agent, and verifier: 600 + 120 + 120 seconds.
  expect(await checkRegistryTask(directory, harborEnv)).toEqual({
    minutes: 14,
    judge: { variables: [], required: [] },
  });
  for (const [path, text] of Object.entries(published))
    expect(await readFile(join(directory, path), "utf8")).toBe(text);

  // A prebuilt image alone, with no Dockerfile, is the task as published too; a task with no
  // agent limit is bounded by SelfBench's default (Harbor still runs it without one).
  const { "environment/Dockerfile": _, ...withoutDockerfile } = published;
  const prebuilt = await taskDirectory({
    ...withoutDockerfile,
    "task.toml": harborTaskToml("x/y", 'docker_image = "someone/build:1"\n').replace(
      "[agent]\ntimeout_sec = 120.0\n",
      "",
    ),
  });
  expect((await checkRegistryTask(prebuilt, harborEnv)).minutes).toBe(10 + 40 + 2);

  // An LLM judge's key and literal settings are the task as published too: the run fills the key
  // from the benchmark's judge credential.
  const judged = await taskDirectory({
    ...published,
    "task.toml": harborTaskToml("x/judged").replace(
      "[verifier.env]\n",
      `[verifier.env]\nANTHROPIC_API_KEY = "\${ANTHROPIC_API_KEY}"\nMODE = "strict"\n`,
    ),
  });
  expect((await checkRegistryTask(judged, harborEnv)).judge).toEqual({
    variables: ["ANTHROPIC_API_KEY"],
    required: ["ANTHROPIC_API_KEY"],
  });
});

test.each([
  ["a solution env", { "task.toml": `${harborTaskToml("x/y")}LEAK = "\${MODAL_TOKEN_SECRET}"\n` }],
  [
    "an MCP server",
    {
      "task.toml": harborTaskToml("x/y").replace(
        "mcp_servers = []",
        'mcp_servers = [{ name = "x", command = "sh" }]',
      ),
    },
  ],
  ["steps", { "task.toml": `${harborTaskToml("x/y")}\n[[steps]]\nname = "one"\n` }],
  [
    "a compose file reading a host secret",
    {
      "environment/docker-compose.yaml":
        "services:\n  main:\n    environment:\n      - K=$MODAL_TOKEN_SECRET\n",
    },
  ],
  ["an unparseable task.toml", { "task.toml": "[task\n" }],
])("a registry task with %s is refused", async (_label, change) => {
  const files: Record<string, string> = { ...publishedTask("x/y").files };
  for (const [path, text] of Object.entries(change)) {
    if (text === undefined) delete files[path];
    else files[path] = text;
  }
  const directory = await taskDirectory(files);
  await expect(checkRegistryTask(directory, harborEnv)).rejects.toBeInstanceOf(
    UnsafeHarborTaskError,
  );
});

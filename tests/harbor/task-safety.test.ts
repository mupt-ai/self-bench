import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { TaskDefinition } from "../../src/contracts/index.js";
import { serviceComposeYaml, taskToml } from "../../src/generation/task/render.js";
import {
  assertHostSafeTask,
  UnsafeHarborTaskError,
} from "../../src/harnesses/harbor/task-safety.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const harborEnv = { PATH: "/usr/bin", HOME: "/home/node", MODAL_TOKEN_SECRET: "as-secret" };

const definition = {
  taskId: "example",
  difficulty: "medium",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  workdir: "project",
  sourcePr: 1,
  timeouts: { setupSeconds: 1, agentSeconds: 1, testsSeconds: 1 },
  resources: { cpus: 1, memoryMb: 1024, storageMb: 1024 },
  environment: {
    services: [
      {
        name: "redis",
        image: `redis:7@sha256:${"b".repeat(64)}`,
        environmentVariables: {},
        command: ["sh", "-c", "echo $HOME"],
        healthcheck: {
          test: ["CMD", "redis-cli", "ping"],
          intervalSeconds: 2,
          timeoutSeconds: 1,
          retries: 10,
          startPeriodSeconds: 0,
        },
      },
    ],
  },
} as unknown as TaskDefinition;

async function taskDirectory(toml: string, compose?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-task-safety-"));
  roots.push(root);
  await mkdir(join(root, "tests"));
  await writeFile(join(root, "task.toml"), toml);
  if (compose !== undefined) await writeFile(join(root, "tests", "docker-compose.yaml"), compose);
  return root;
}

test("a compiler-rendered task passes and task.toml is rewritten to the same configuration", async () => {
  const toml = taskToml(definition);
  const root = await taskDirectory(toml, serviceComposeYaml(definition));
  await assertHostSafeTask(root, harborEnv);
  expect(parse(await readFile(join(root, "task.toml"), "utf8"))).toEqual(parse(toml));
});

test.each([
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
  ["environment env", '[environment.env]\nLEAK = "${MODAL_TOKEN_SECRET}"\n'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
  ["verifier env", '[verifier.env]\nLEAK = "${MODAL_TOKEN_SECRET}"\n'],
  ["separate verifier environment env", '[verifier.environment.env]\nLEAK = "x"\n'],
  // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
  ["solution env", '[solution.env]\nLEAK = "${MODAL_TOKEN_SECRET}"\n'],
  ["escaped template", '[environment]\nenv = { LEAK = "\\u0024{MODAL_TOKEN_SECRET}" }\n'],
  ["steps", '[[steps]]\nname = "one"\n[steps.verifier.env]\nLEAK = "x"\n'],
  ["mcp servers", '[[environment.mcp_servers]]\nname = "x"\ncommand = "sh"\n'],
])("task.toml with %s is refused", async (_label, toml) => {
  const root = await taskDirectory(`schema_version = "1.4"\n${toml}`);
  await expect(assertHostSafeTask(root, harborEnv)).rejects.toBeInstanceOf(UnsafeHarborTaskError);
});

test("free-form metadata may use any key", async () => {
  const root = await taskDirectory('schema_version = "1.4"\n[metadata]\nenv = "prod"\n');
  await assertHostSafeTask(root, harborEnv);
});

test("a compose file may not name a credential the Harbor process holds", async () => {
  // Harbor's Modal compose mode matches the name even behind Compose's `$$` escape.
  for (const reference of [
    // biome-ignore lint/suspicious/noTemplateCurlyInString: exercises Harbor's host interpolation.
    "${MODAL_TOKEN_SECRET}",
    "$$MODAL_TOKEN_SECRET",
    "$MODAL_TOKEN_SECRET",
  ]) {
    const root = await taskDirectory(
      'schema_version = "1.4"\n',
      JSON.stringify({ services: { main: { command: ["sh", "-c", `echo ${reference}`] } } }),
    );
    await expect(assertHostSafeTask(root, harborEnv)).rejects.toThrow("MODAL_TOKEN_SECRET");
  }
  const harmless = await taskDirectory(
    'schema_version = "1.4"\n',
    JSON.stringify({ services: { main: { command: ["sh", "-c", "echo $$HOME $$UNSET_NAME"] } } }),
  );
  await assertHostSafeTask(harmless, harborEnv);
});

test("an unparseable task.toml is refused", async () => {
  const root = await taskDirectory("[environment\n");
  await expect(assertHostSafeTask(root, harborEnv)).rejects.toThrow("does not parse");
});

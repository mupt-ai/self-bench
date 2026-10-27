import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { TaskImages } from "../../src/contracts/index.js";
import { startFromTaskImages } from "../../src/harnesses/harbor/registry-pull.js";
import { readRegistryGrant } from "../../src/sandbox/registry-grant.js";

const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const SECRET = "s".repeat(32);
const AGENT = `run/candidate/agent@sha256:${"a".repeat(64)}`;
const VERIFIER = `run/candidate/verifier@sha256:${"b".repeat(64)}`;
const images: TaskImages = {
  agent: `${REPOSITORY}/${AGENT}`,
  verifier: `${REPOSITORY}/${VERIFIER}`,
};
const serving = {
  env: { SELFBENCH_TASK_IMAGE_REPOSITORY: REPOSITORY },
  callback: { url: "https://app.selfbench.test", secret: SECRET },
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function task(toml: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "selfbench-registry-pull-"));
  roots.push(root);
  await writeFile(join(root, "task.toml"), toml);
  return root;
}

type Config = {
  environment: { docker_image: string };
  verifier: { environment: { docker_image: string; cpus: number } };
};

test("every hosted provider pulls a task's images by digest through the API", async () => {
  for (const environment of ["e2b", "modal", "daytona", "vercel"] as const) {
    const root = await task('schema_version = "1.4"\n[verifier.environment]\ncpus = 2\n');
    const env = await startFromTaskImages(root, images, environment, serving);
    const config = parse(await readFile(join(root, "task.toml"), "utf8")) as Config;
    expect(config.environment.docker_image).toBe(`app.selfbench.test/${AGENT}`);
    expect(config.verifier.environment).toEqual({
      cpus: 2,
      docker_image: `app.selfbench.test/${VERIFIER}`,
    });
    expect(env.SELFBENCH_REGISTRY_HOST).toBe("app.selfbench.test");
    // The login is a grant for exactly this task's two images.
    expect(readRegistryGrant(env.SELFBENCH_REGISTRY_PASSWORD ?? "", SECRET)?.images).toEqual([
      AGENT,
      VERIFIER,
    ]);
  }
});

test("Docker pulls straight from the repository with the host's own login", async () => {
  const local = {
    agent: `localhost:5000/tasks/${AGENT}`,
    verifier: `localhost:5000/tasks/${VERIFIER}`,
  };
  const root = await task('schema_version = "1.4"\n');
  expect(await startFromTaskImages(root, local, "docker", { env: {} })).toEqual({});
  const config = parse(await readFile(join(root, "task.toml"), "utf8")) as Config;
  expect(config.environment.docker_image).toBe(local.agent);
  expect(config.verifier.environment.docker_image).toBe(local.verifier);
});

test("service contexts build FROM the proxied image the compose login covers", async () => {
  const root = await task('schema_version = "1.4"\n');
  for (const context of ["environment", "tests"]) {
    await mkdir(join(root, context));
    await writeFile(join(root, context, "Dockerfile"), `FROM ${REPOSITORY}/${AGENT}\n`);
  }
  await writeFile(
    join(root, "tests", "docker-compose.yaml"),
    '{"services":{"main":{"build":"."}}}',
  );
  await startFromTaskImages(root, images, "daytona", serving);
  expect(await readFile(join(root, "tests", "Dockerfile"), "utf8")).toBe(
    `FROM app.selfbench.test/${VERIFIER}\n`,
  );
  // A context without services starts from `docker_image`; its Dockerfile is left alone.
  expect(await readFile(join(root, "environment", "Dockerfile"), "utf8")).toBe(
    `FROM ${REPOSITORY}/${AGENT}\n`,
  );
});

test("a task without images builds its Dockerfiles; one a provider cannot pull refuses", async () => {
  const toml = 'schema_version = "1.4"\n';
  const root = await task(toml);
  expect(await startFromTaskImages(root, undefined, "e2b", serving)).toEqual({});
  expect(await readFile(join(root, "task.toml"), "utf8")).toBe(toml);
  await expect(startFromTaskImages(root, images, "e2b", { ...serving, env: {} })).rejects.toThrow(
    "Artifact Registry",
  );
  await expect(startFromTaskImages(root, images, "modal", { env: serving.env })).rejects.toThrow(
    "sandbox callback",
  );
});

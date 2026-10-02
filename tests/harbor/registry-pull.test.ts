import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { TaskImages } from "../../src/contracts/index.js";
import { startFromExportedImages } from "../../src/harnesses/harbor/registry-pull.js";
import { readRegistryGrant } from "../../src/sandbox/registry-grant.js";

const REPOSITORY = "us-central1-docker.pkg.dev/selfbench-test/selfbench-tasks";
const SECRET = "s".repeat(32);
const AGENT = `task-1@sha256:${"a".repeat(64)}`;
const VERIFIER = `task-1@sha256:${"b".repeat(64)}`;
const images: TaskImages = {
  provider: "modal",
  agent: "im-Agent1",
  verifier: "im-Verifier1",
  registry: { agent: `${REPOSITORY}/${AGENT}`, verifier: `${REPOSITORY}/${VERIFIER}` },
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

test("an E2B or Docker trial starts from the task's exported images, by digest through the API", async () => {
  for (const environment of ["e2b", "docker"] as const) {
    const root = await task('schema_version = "1.4"\n[verifier.environment]\ncpus = 2\n');
    const env = await startFromExportedImages(root, images, environment, serving, root);

    const config = parse(await readFile(join(root, "task.toml"), "utf8")) as {
      environment: { docker_image: string };
      verifier: { environment: { docker_image: string; cpus: number } };
    };
    expect(config.environment.docker_image).toBe(`app.selfbench.test/${AGENT}`);
    expect(config.verifier.environment).toEqual({
      cpus: 2,
      docker_image: `app.selfbench.test/${VERIFIER}`,
    });
    expect(env.SELFBENCH_REGISTRY_HOST).toBe("app.selfbench.test");
    // The login is a grant for exactly this task's two images, for E2B and the docker CLI alike.
    expect(readRegistryGrant(env.SELFBENCH_REGISTRY_PASSWORD ?? "", SECRET)?.images).toEqual([
      AGENT,
      VERIFIER,
    ]);
    const docker = JSON.parse(await readFile(join(env.DOCKER_CONFIG ?? "", "config.json"), "utf8"));
    expect(docker.auths["app.selfbench.test"].auth).toBe(
      Buffer.from(`selfbench:${env.SELFBENCH_REGISTRY_PASSWORD}`).toString("base64"),
    );
  }
});

test("Modal keeps its own images, and an unexported task builds its Dockerfiles", async () => {
  const toml = 'schema_version = "1.4"\n';
  const cases = [
    { images, environment: "modal" as const, options: serving },
    { images: { ...images, registry: undefined }, environment: "e2b" as const, options: serving },
    { images, environment: "e2b" as const, options: { ...serving, env: {} } },
  ];
  for (const { images: taskImages, environment, options } of cases) {
    const root = await task(toml);
    expect(
      await startFromExportedImages(
        root,
        taskImages as TaskImages,
        environment,
        options as typeof serving,
        root,
      ),
    ).toEqual({});
    expect(await readFile(join(root, "task.toml"), "utf8")).toBe(toml);
  }
});

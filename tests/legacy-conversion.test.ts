import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LegacyDefinition, legacySubmission } from "../src/generation/task/legacy.js";
import { checkSubmission } from "../src/generation/task/submission.js";
import { runCommand } from "../src/lib/process.js";
import { goldPatch, testPatch } from "./support/submission-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const definition: LegacyDefinition = {
  difficulty: "easy",
  repo: "example/repo",
  baseCommit: "a".repeat(40),
  sourcePr: 1,
  workdir: "project",
  testCommand: "echo {tests} >> ../ran",
  failToPass: ["new test.ts"],
  passToPass: ["old.ts"],
  environment: {
    baseImage: `node:22@sha256:${"c".repeat(64)}`,
    rootSetupCommand: "apt-get update && apt-get install -y git",
    setupCommand: 'npm ci && echo "done"',
    smokeCommand: "npm --version",
    environmentVariables: { NODE_ENV: "test", CI: "1" },
    services: [],
  },
};
const files = { instruction: "Do it.\n", testPatch, goldPatch };

test("a legacy definition becomes a Dockerfile with the legacy compiler's steps", () => {
  const submission = legacySubmission(definition, files);
  if ("reason" in submission) throw new Error(submission.reason);
  expect(submission.Dockerfile).toBe(
    [
      `FROM ${definition.environment.baseImage}`,
      'RUN ["/bin/sh","-eu","-c","apt-get update && apt-get install -y git"]',
      'ENV CI="1"',
      'ENV NODE_ENV="test"',
      "ADD repo.tar.gz /app/",
      "WORKDIR /app/project",
      'RUN ["bash","-euo","pipefail","-c","npm ci && echo \\"done\\""]',
      "",
    ].join("\n"),
  );
  expect(submission["smoke.sh"]).toBe("set -euo pipefail\ncd '/app/project'\nnpm --version\n");
  expect(checkSubmission(submission, "easy").errors).toEqual([]);
});

test("run-tests.sh runs each selection from the workdir, as the legacy verifier did", async () => {
  const submission = legacySubmission(definition, files);
  if ("reason" in submission) throw new Error(submission.reason);
  const root = await mkdtemp(join(tmpdir(), "selfbench-legacy-"));
  roots.push(root);
  await mkdir(join(root, "project"));
  const script = join(root, "run-tests.sh");
  await writeFile(
    script,
    submission["run-tests.sh"].replaceAll("/app/project", join(root, "project")),
  );
  for (const mode of ["fail-to-pass", "pass-to-pass"]) await runCommand("bash", [script, mode]);
  expect(await Bun.file(join(root, "ran")).text()).toBe("new test.ts\nold.ts\n");
  expect((await runCommand("bash", [script, "other"], { allowFailure: true })).exitCode).toBe(2);
});

test("services cannot be converted", () => {
  const withServices = {
    ...definition,
    environment: { ...definition.environment, services: [{}] },
  };
  expect(legacySubmission(withServices, files)).toEqual({
    reason: "it declares services, which now run inside its image (services.sh)",
  });
});

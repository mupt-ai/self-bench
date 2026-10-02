import { expect, test } from "bun:test";
import { loadConfig } from "../src/contracts/config/index.js";

test("task images live only in an Artifact Registry repository", () => {
  const repository = "us-central1-docker.pkg.dev/selfbench-prod/selfbench-tasks";
  expect(loadConfig({}).taskImages).toBeUndefined();
  expect(loadConfig({ SELFBENCH_TASK_IMAGE_REPOSITORY: repository }).taskImages).toEqual({
    repository,
  });
  expect(() =>
    loadConfig({ SELFBENCH_TASK_IMAGE_REPOSITORY: "docker.io/selfbench/tasks" }),
  ).toThrow("<region>-docker.pkg.dev");
});

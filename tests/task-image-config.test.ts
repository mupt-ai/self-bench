import { expect, test } from "bun:test";
import { loadConfig } from "../src/contracts/config/index.js";

const repository = "us-central1-docker.pkg.dev/selfbench-prod/selfbench-tasks";

test("Cloud Build images live in Artifact Registry, built as the builder's own account", () => {
  expect(loadConfig({}).taskImages).toBeUndefined();
  // A repository alone still serves the images earlier tasks were given.
  expect(loadConfig({ SELFBENCH_TASK_IMAGE_REPOSITORY: repository }).taskImages).toEqual({
    repository,
  });
  expect(
    loadConfig({
      SELFBENCH_TASK_IMAGE_REPOSITORY: repository,
      SELFBENCH_TASK_IMAGE_BUILDER: "cloud-build",
      SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT: "builder@selfbench-prod.iam.gserviceaccount.com",
      SELFBENCH_CLOUD_BUILD_LOGS_BUCKET: "selfbench-prod-task-builds",
      SELFBENCH_TASK_IMAGE_CACHE: "us-central1-docker.pkg.dev/selfbench-prod/selfbench-task-cache",
      SELFBENCH_DOCKER_HUB_MIRROR: "us-central1-docker.pkg.dev/selfbench-prod/dockerhub",
    }).taskImages,
  ).toEqual({
    repository,
    builder: {
      kind: "cloud-build",
      project: "selfbench-prod",
      region: "us-central1",
      serviceAccount: "builder@selfbench-prod.iam.gserviceaccount.com",
      logsBucket: "selfbench-prod-task-builds",
      cache: "us-central1-docker.pkg.dev/selfbench-prod/selfbench-task-cache",
      mirror: "us-central1-docker.pkg.dev/selfbench-prod/dockerhub",
    },
  });
  expect(() =>
    loadConfig({ SELFBENCH_TASK_IMAGE_REPOSITORY: "docker.io/selfbench/tasks" }),
  ).toThrow("<region>-docker.pkg.dev");
  expect(() =>
    loadConfig({
      SELFBENCH_TASK_IMAGE_REPOSITORY: repository,
      SELFBENCH_TASK_IMAGE_BUILDER: "cloud-build",
    }),
  ).toThrow("SELFBENCH_CLOUD_BUILD_SERVICE_ACCOUNT");
  expect(() => loadConfig({ SELFBENCH_TASK_IMAGE_BUILDER: "docker" })).toThrow(
    "needs SELFBENCH_TASK_IMAGE_REPOSITORY",
  );
});

test("the Docker builder pushes to any registry, such as a local one", () => {
  expect(
    loadConfig({
      SELFBENCH_TASK_IMAGE_REPOSITORY: "localhost:5000/selfbench-tasks",
      SELFBENCH_TASK_IMAGE_BUILDER: "docker",
    }).taskImages,
  ).toEqual({ repository: "localhost:5000/selfbench-tasks", builder: { kind: "docker" } });
});

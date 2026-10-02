import { expect, test } from "bun:test";
import type { AuthoredTask } from "../../../src/contracts/index.js";
import { executeCandidate } from "../../../src/generation/pipeline/workflows.js";
import { acceptingActivities, candidate, run } from "../../support/workflow-fixture.js";

const exported = `us-central1-docker.pkg.dev/p/selfbench-tasks/green-task@sha256:${"a".repeat(64)}`;

test("an accepted task carries its exported images; a failed export keeps it accepted", async () => {
  const value = candidate("green", 1);
  for (const outcome of ["exported", "failed"] as const) {
    const activities = acceptingActivities([value]);
    const exports: string[] = [];
    activities.exportTaskImages = async ({ task }): Promise<AuthoredTask> => {
      exports.push(task.taskId);
      if (outcome === "failed") throw new Error("Modal lost the image");
      return {
        ...task,
        images: { provider: "modal", agent: "im-Agent1", registry: { agent: exported } },
      };
    };

    const result = await executeCandidate({ run, candidate: value }, activities, () => {});

    expect(exports).toEqual(["green-task"]);
    expect(result.progress.status).toBe("accepted");
    expect(result.task?.taskId).toBe("green-task");
    expect(result.task?.images?.registry?.agent).toBe(
      outcome === "exported" ? exported : undefined,
    );
  }
});

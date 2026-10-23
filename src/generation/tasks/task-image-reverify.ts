import { dirname } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import { withExecutionEnvironment } from "../../contracts/config/execution-environment.js";
import type { TaskImages } from "../../contracts/index.js";
import { runHarborGates } from "../pipeline/harbor-gates.js";
import type { ReviewedTask, TaskImageOutcome } from "./task-images.js";

export type ReverifyOutcome =
  | { readonly status: "planned"; readonly provider: TaskImages["provider"] }
  | { readonly status: "recorded"; readonly provider: TaskImages["provider"] }
  | { readonly status: "exported"; readonly bundleKey: string }
  | { readonly status: "failed"; readonly gate: string; readonly outputs: string }
  | { readonly status: "skipped"; readonly reason: string };

export interface ReverifyDependencies {
  readonly apply: boolean;
  /** The provider the task's own run verified on, which the export later reads its images from. */
  readonly provider: () => Promise<TaskImages["provider"]>;
  /** That run's verification account, as the Harbor process sees it. */
  readonly environment: (provider: TaskImages["provider"]) => Promise<NodeJS.ProcessEnv>;
  /** Records the images on the row unless the task changed meanwhile. */
  readonly save: (images: TaskImages) => Promise<boolean>;
  /** Exports an approved task's newly recorded images, as a review would. */
  readonly export: (images: TaskImages) => Promise<TaskImageOutcome>;
  readonly signal: AbortSignal;
  readonly gates?: typeof runHarborGates;
  readonly now?: () => Date;
}

/**
 * Gives an accepted task that predates image recording the images it is verified on. Its own
 * compiled bundle goes through the build, smoke, nop and oracle gates again, on the provider and
 * account its run verified with, and the images the oracle started from are recorded on the row.
 * The task's files are unchanged; only images that pass every gate again are recorded. An
 * approved task is then exported, as approval exports any task; others wait for their review.
 */
export async function reverifyTaskImages(
  store: ArtifactStore,
  task: ReviewedTask,
  deps: ReverifyDependencies,
): Promise<ReverifyOutcome> {
  if (task.images) return { status: "skipped", reason: "Already has verified images" };
  if (!task.bundleKey || task.pipelineStatus !== "accepted" || task.deletedAt)
    return { status: "skipped", reason: "Not an accepted task" };
  if (task.reviewDecision === "reject") return { status: "skipped", reason: "Rejected in review" };
  const provider = await deps.provider();
  // Resolving the account in a dry run shows which tasks an apply could not verify.
  const environment = await deps.environment(provider);
  if (!deps.apply) return { status: "planned", provider };
  const bundle = await store.stat(task.bundleKey);
  if (!bundle) throw new Error("Original compiled bundle is missing");
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const outputs = `${dirname(task.bundleKey)}/reverify-${stamp}`;
  const gates = await withExecutionEnvironment(environment, () =>
    (deps.gates ?? runHarborGates)(
      store,
      { taskId: task.taskId, bundle: { ...bundle, contentType: "application/gzip" } },
      provider,
      outputs,
      deps.signal,
    ),
  );
  const failed = (["build", "smoke", "nop", "oracle"] as const).find((gate) => !gates[gate].ok);
  if (failed) return { status: "failed", gate: failed, outputs };
  if (!gates.images?.verifier) return { status: "failed", gate: "image record", outputs };
  if (!(await deps.save(gates.images)))
    throw new Error("Task changed during re-verification; its row is unchanged");
  if (task.reviewDecision !== "approve") return { status: "recorded", provider };
  const exported = await deps.export(gates.images);
  if (exported.status !== "exported")
    throw new Error(`Recorded images but the export ${exported.status}`);
  return exported;
}

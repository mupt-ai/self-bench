import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ArtifactStore } from "../../artifacts/index.js";
import { withExecutionEnvironment } from "../../contracts/config/execution-environment.js";
import { type HarborEnvironment, isHarborEnvironment } from "../../contracts/config/providers.js";
import type { ArtifactRef, TaskImages } from "../../contracts/index.js";
import type { Vault } from "../../db/vault.js";
import { GATE_TASK_FILE, SNAPSHOT_FILE, splitGateBundle } from "../../sandbox/gate-bundle.js";
import {
  providerCredentialEnvironment,
  providerEnvironment,
} from "../../sandbox/provider-environment.js";
import {
  managedHarborEnvironment,
  managedModalEnvironment,
  managedSandboxCredentials,
} from "../billing/managed.js";
import type { TaskImageBuilder } from "../images/builder.js";
import { publishExecutionBundle } from "../pipeline/execution-bundle.js";
import { type GateImages, runHarborGates } from "../pipeline/harbor-gates.js";
import { generationRecordPath } from "../settings/credentials.js";
import type { GenerationReference } from "../settings/settings.js";
import { attemptSnapshot } from "../task/snapshot-store.js";
import { compiledBundleKey, type ReviewedTask } from "./task-images.js";

export type RebuildOutcome =
  | { readonly status: "rebuilt"; readonly bundleKey: string; readonly images: TaskImages }
  | { readonly status: "failed"; readonly gate: string; readonly outputs: string }
  | { readonly status: "skipped"; readonly reason: string };

/** A task that runs on its Dockerfiles but should run on images: accepted, kept, without them. */
export function needsImages(task: ReviewedTask & { readonly pipelineStatus: string }): boolean {
  return (
    task.pipelineStatus === "accepted" &&
    !task.images &&
    !!task.bundleKey &&
    !task.deletedAt &&
    task.reviewDecision !== "reject"
  );
}

/** The rebuild's verification provider and account; managed accounts have no vault credential. */
export interface Verification {
  readonly provider: HarborEnvironment;
  readonly env: NodeJS.ProcessEnv;
  readonly orgId: number;
  readonly credentialId?: string;
}

export interface RebuildDependencies {
  readonly builder: TaskImageBuilder;
  /** The run's saved customer account, or the deployment's managed verification account. */
  readonly verification: Verification;
  readonly serving: GateImages["serving"];
  /** Records the images and execution bundle unless the row changed meanwhile. */
  readonly save: (bundleKey: string, images: TaskImages) => Promise<boolean>;
  /**
   * Deletes every image under the task's candidate names except `keep` and what something else
   * pins, so a push the build never reported (one image of the pair, a lost worker) goes too.
   */
  readonly discardImages: (keep?: TaskImages) => Promise<void>;
  readonly signal: AbortSignal;
  readonly now?: () => Date;
  readonly gates?: typeof runHarborGates;
}

/**
 * Gives a task that runs on its Dockerfiles (accepted before images were built, or re-approved
 * after a rejection removed them) the images every new task gets, from its own compiled task
 * (checkCompiledTask); the task's files never change.
 */
export async function rebuildTaskImages(
  store: ArtifactStore,
  task: ReviewedTask & { readonly pipelineStatus: string; readonly candidateId: string },
  deps: RebuildDependencies,
): Promise<RebuildOutcome> {
  if (!needsImages(task)) return { status: "skipped", reason: "Has images, or is not a kept task" };
  return await checkCompiledTask(store, task, compiledBundleKey(task.bundleKey as string), deps);
}

/**
 * Builds the images of the compiled task at `compiled` and runs the smoke, nop and oracle gates
 * on them, using the task's saved customer account or the deployment's managed account. Only
 * images that pass every gate are recorded (`deps.save`), with the execution bundle that runs
 * them; images that fail are deleted.
 */
export async function checkCompiledTask(
  store: ArtifactStore,
  task: Pick<ReviewedTask, "taskId" | "runId"> & { readonly candidateId: string },
  compiled: string,
  deps: RebuildDependencies,
): Promise<RebuildOutcome> {
  const stat = await store.stat(compiled);
  if (!stat) throw new Error("Original compiled bundle is missing");
  const bundle: ArtifactRef = { ...stat, contentType: "application/gzip" };
  const { provider, env } = deps.verification;
  const directory = dirname(compiled);
  const { gate, snapshot } = await gateSource(store, compiled, deps.signal);
  const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const outputs = `${directory}/rebuild-${stamp}`;
  // Whatever the builder pushed is deleted unless the row ends up naming it.
  try {
    const gates = await withExecutionEnvironment(env, () =>
      (deps.gates ?? runHarborGates)(
        store,
        { taskId: task.taskId, bundle },
        provider,
        outputs,
        deps.signal,
        {
          builder: deps.builder,
          build: {
            runId: task.runId,
            candidateId: task.candidateId,
            gate,
            snapshot,
            prefix: outputs,
          },
          serving: deps.serving,
        },
      ),
    );
    const failed = (["build", "smoke", "nop", "oracle"] as const).find((name) => !gates[name].ok);
    if (failed || !gates.images) {
      await deps.discardImages();
      return { status: "failed", gate: failed ?? "images", outputs };
    }
    const delivered = await publishExecutionBundle(
      store,
      { bundle, images: gates.images },
      gate,
      deps.signal,
    );
    const bundleKey = delivered.uri.slice(delivered.uri.indexOf("/runs/") + 1);
    if (!(await deps.save(bundleKey, gates.images)))
      throw new Error("Task changed during the rebuild; its row is unchanged");
    // Earlier attempts' pushes go; only storage is at stake, so this never fails the rebuild.
    await deps.discardImages(gates.images).catch(() => {});
    return { status: "rebuilt", bundleKey, images: gates.images };
  } catch (error) {
    // A failed build or publish, or a save the row refused: nothing names these images.
    await deps.discardImages();
    throw error;
  }
}

/**
 * The gate task and snapshot beside a compiled bundle. Compiles of tasks with services, and older
 * ones, wrote neither: the full bundle is split once and both are stored beside it.
 */
export async function gateSource(
  store: ArtifactStore,
  compiled: string,
  signal: AbortSignal,
): Promise<{ gate: ArtifactRef; snapshot: ArtifactRef }> {
  const directory = dirname(compiled);
  const gzip = (ref: Omit<ArtifactRef, "contentType">): ArtifactRef => ({
    ...ref,
    contentType: "application/gzip",
  });
  const gate = await store.stat(`${directory}/${GATE_TASK_FILE}`);
  const stored = await attemptSnapshot(store, directory);
  const snapshot = stored && (await store.stat(stored.key));
  if (gate && snapshot) return { gate: gzip(gate), snapshot: gzip(snapshot) };
  const work = await mkdtemp(join(tmpdir(), "selfbench-rebuild-"));
  try {
    const archive = join(work, "compiled.tar.gz");
    const bundle = await store.openReadByKey(compiled);
    if (!bundle) throw new Error("Original compiled bundle is missing");
    await pipeline(bundle, createWriteStream(archive), { signal });
    await splitGateBundle(archive, work);
    // Streamed from disk: a repository snapshot can be larger than a Harbor slot's memory.
    const put = (name: string) =>
      store.putFile(`${directory}/${name}`, join(work, name), "application/gzip");
    return { gate: await put(GATE_TASK_FILE), snapshot: await put(SNAPSHOT_FILE) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The provider and Harbor environment a run checked its tasks on, from its saved settings and the
 * organization's own credential; never the worker's. Managed rebuilds run fresh gates on the
 * deployment's currently configured managed provider, using only its platform credentials, or
 * on `managed` instead when an operator names an organization's own credential for them.
 */
export async function verificationEnvironment(
  vault: Pick<Vault, "records" | "credentials">,
  runId: string,
  base: NodeJS.ProcessEnv,
  managed?: VerifyingCredential,
): Promise<Verification> {
  const saved = await vault.records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved) throw new Error("Original generation configuration is missing");
  const { settings } = saved.value;
  if (settings.sandbox === "managed" && managed)
    return await credentialVerification(vault, managed, base);
  if (settings.sandbox === "managed") {
    const provider = managedHarborEnvironment(base);
    const env = providerEnvironment(base, "docker");
    if (provider === "modal") Object.assign(env, managedModalEnvironment(base));
    else {
      const managed = managedSandboxCredentials(base);
      Object.assign(
        env,
        providerCredentialEnvironment("e2b", { value: managed.apiKey, domain: managed.domain }),
      );
    }
    return { provider, env, orgId: saved.value.orgId ?? saved.value.ownerId };
  }
  const provider = settings.harborEnvironment ?? settings.sandbox;
  const id = settings.harborEnvironment
    ? settings.harborCredentialId
    : settings.sandboxCredentialId;
  if (!id) throw new Error("Original verification credential is missing");
  const orgId = saved.value.orgId ?? saved.value.ownerId;
  return await credentialVerification(vault, { orgId, credentialId: id }, base, provider);
}

/** An organization's saved sandbox credential, which checks a task on its provider. */
export interface VerifyingCredential {
  readonly orgId: number;
  readonly credentialId: string;
}

async function credentialVerification(
  vault: Pick<Vault, "credentials">,
  { orgId, credentialId }: VerifyingCredential,
  base: NodeJS.ProcessEnv,
  provider?: HarborEnvironment,
): Promise<Verification> {
  const credential = await vault.credentials.find(orgId, credentialId);
  const secret =
    credential?.auth === "api-key"
      ? await vault.credentials.secret(orgId, credentialId)
      : undefined;
  const kind = credential?.kind;
  if (!kind || !isHarborEnvironment(kind) || (provider && kind !== provider) || !secret?.value)
    throw new Error("Verification credential is unavailable");
  // Start from the runtime whitelist, not the worker's own provider credentials.
  return {
    provider: kind,
    env: {
      ...providerEnvironment(base, "docker"),
      ...providerCredentialEnvironment(kind, secret),
    },
    orgId,
    credentialId,
  };
}

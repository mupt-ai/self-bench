import type { TaskImageBuilderConfig } from "../../contracts/config/task-images.js";
import { googleAccessToken } from "../../lib/google-access-token.js";
import type { RegistryAccess } from "./registry.js";

type CloudBuildConfig = Extract<TaskImageBuilderConfig, { kind: "cloud-build" }>;

/** The parts of a Cloud Build `Build` the builder reads. */
export interface FinishedBuild {
  readonly id: string;
  readonly status: string;
  readonly statusDetail?: string;
  readonly steps?: readonly { readonly id?: string; readonly status?: string }[];
  readonly results?: { readonly buildStepOutputs?: readonly string[] };
}

/** Runs one build to its end, and reads its log. */
export interface CloudBuildApi {
  run(build: Record<string, unknown>, signal: AbortSignal): Promise<FinishedBuild>;
  log(buildId: string): Promise<string>;
}

const DONE = new Set(["SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"]);
const POLL_MS = 10_000;

/**
 * Cloud Build's REST API in the deployment's own project and region, as the worker's identity
 * (which may create builds and act as the builder's service account, nothing more). Builds run as
 * that service account on a large machine, and write their logs only to the logs bucket.
 * Cancelling the activity cancels the build.
 */
export function googleCloudBuild(
  config: CloudBuildConfig,
  access: RegistryAccess = { token: googleAccessToken, fetch: (input, init) => fetch(input, init) },
  pollMs = POLL_MS,
): CloudBuildApi {
  const base = `https://cloudbuild.googleapis.com/v1/projects/${config.project}/locations/${config.region}/builds`;
  const call = async (url: string, init: RequestInit = {}) => {
    const response = await access.fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await access.token()}`,
        "content-type": "application/json",
      },
    });
    if (!response.ok)
      throw new Error(
        `Cloud Build answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    return (await response.json()) as Record<string, unknown>;
  };
  return {
    async run(build, signal) {
      const operation = await call(base, {
        method: "POST",
        body: JSON.stringify({
          ...build,
          serviceAccount: `projects/${config.project}/serviceAccounts/${config.serviceAccount}`,
          logsBucket: `gs://${config.logsBucket}`,
          options: { logging: "GCS_ONLY", machineType: "E2_HIGHCPU_8", diskSizeGb: 200 },
        }),
      });
      const id = (operation.metadata as { build?: { id?: string } } | undefined)?.build?.id;
      if (!id) throw new Error("Cloud Build started no build");
      const cancel = () => void call(`${base}/${id}:cancel`, { method: "POST" }).catch(() => {});
      signal.addEventListener("abort", cancel, { once: true });
      try {
        for (;;) {
          const current = (await call(`${base}/${id}`)) as unknown as FinishedBuild;
          if (DONE.has(current.status)) return { ...current, id };
          signal.throwIfAborted();
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
      } finally {
        signal.removeEventListener("abort", cancel);
      }
    },
    async log(buildId) {
      const object = encodeURIComponent(`log-${buildId}.txt`);
      const response = await access.fetch(
        `https://storage.googleapis.com/storage/v1/b/${config.logsBucket}/o/${object}?alt=media`,
        { headers: { authorization: `Bearer ${await access.token()}` } },
      );
      return response.ok ? await response.text() : "";
    },
  };
}

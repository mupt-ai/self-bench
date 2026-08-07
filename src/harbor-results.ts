import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface HarborJobResult {
  readonly job: unknown;
  readonly trial: unknown;
}

const infrastructurePatterns = [
  /unknown flag: --project-name/i,
  /cannot connect to the docker daemon/i,
  /error during connect/i,
  /connection refused/i,
  /modal.*(?:unavailable|timed out|timeout)/i,
  /image build for im-[a-z0-9]+ failed/i,
  /all predefined address pools have been fully subnetted/i,
];

class IncompleteHarborJobError extends Error {}

export function harborInfrastructureError(trial: unknown): string | undefined {
  if (!isRecord(trial) || !isRecord(trial.exception_info)) {
    return undefined;
  }
  const message = trial.exception_info.exception_message;
  const type = trial.exception_info.exception_type;
  if (
    typeof message !== "string" ||
    (type !== "AuthError" && !infrastructurePatterns.some((pattern) => pattern.test(message)))
  ) {
    return undefined;
  }
  return `${typeof type === "string" ? type : "HarborError"}: ${message}`;
}

export async function readHarborJobResult(
  jobsDirectory: string,
  jobName: string,
): Promise<HarborJobResult> {
  const jobDirectory = join(jobsDirectory, jobName);
  const job = JSON.parse(await readFile(join(jobDirectory, "result.json"), "utf8")) as unknown;
  if (isRecord(job) && Array.isArray(job.trial_results) && job.trial_results.length === 1) {
    return { job, trial: job.trial_results[0] };
  }
  const entries = await readdir(jobDirectory, { withFileTypes: true });
  const trialResults: unknown[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const raw = await readFile(join(jobDirectory, entry.name, "result.json"), "utf8").catch(
      (error: unknown) => (isNotFound(error) ? undefined : Promise.reject(error)),
    );
    if (raw) {
      trialResults.push(JSON.parse(raw) as unknown);
    }
  }
  if (trialResults.length !== 1) {
    if (trialResults.length === 0 && isRecord(job) && job.finished_at === null) {
      throw new IncompleteHarborJobError(`Harbor job ${jobName} has not finished`);
    }
    throw new Error(
      `expected one Harbor trial result in ${jobDirectory}, found ${trialResults.length}`,
    );
  }
  return { job, trial: trialResults[0] };
}

export async function tryReadHarborJobResult(
  jobsDirectory: string,
  jobName: string,
): Promise<HarborJobResult | undefined> {
  try {
    return await readHarborJobResult(jobsDirectory, jobName);
  } catch (error) {
    if (isNotFound(error) || error instanceof IncompleteHarborJobError) {
      return undefined;
    }
    throw error;
  }
}

export async function archiveIncompleteHarborJob(
  jobsDirectory: string,
  jobName: string,
): Promise<string | undefined> {
  const source = join(jobsDirectory, jobName);
  const destination = `${source}.incomplete-${Date.now()}`;
  try {
    await rename(source, destination);
    return destination;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

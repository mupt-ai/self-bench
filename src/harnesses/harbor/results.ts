import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../lib/util.js";
import { HarborOutputLimitError, readBoundedText } from "./output-guard.js";

interface HarborVerifierOutput {
  readonly combined?: string;
  readonly stderr?: string;
}

export interface HarborJobResult {
  readonly job: unknown;
  readonly trial: unknown;
  readonly verifier?: HarborVerifierOutput;
  /** Harbor's trial.log: environment build, compose, and agent/verifier orchestration output. */
  readonly trialLog?: string;
}

const infrastructurePatterns = [
  /unknown flag: --project-name/i,
  /cannot connect to the docker daemon/i,
  /error during connect/i,
  /connection refused/i,
  /modal.*(?:unavailable|timed out|timeout)/i,
  /image build for im-[a-z0-9]+ failed/i,
  /all predefined address pools have been fully subnetted/i,
  /mounts denied/i,
  /network-policy[\s\S]*could not process rule/i,
];

class IncompleteHarborJobError extends Error {}

const RESULT_MAX_BYTES = 16 * 1024 * 1024;

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
  const jobResult = await readResult(jobDirectory);
  if (jobResult === undefined) throw new Error(`Harbor job ${jobName} wrote no result.json`);
  const job = JSON.parse(jobResult) as unknown;
  const entries = await readdir(jobDirectory, { withFileTypes: true });
  const trials: Array<{ directory: string; result: unknown }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const directory = join(jobDirectory, entry.name);
    const raw = await readResult(directory);
    if (raw) {
      trials.push({ directory, result: JSON.parse(raw) as unknown });
    }
  }
  const aggregateTrials =
    isRecord(job) && Array.isArray(job.trial_results) ? job.trial_results : [];
  const [onlyTrial] = trials;
  if (onlyTrial && trials.length === 1) {
    const trialLog = await readBoundedText(join(onlyTrial.directory, "trial.log"));
    return {
      job,
      trial: onlyTrial.result,
      ...(await readVerifierOutput(onlyTrial.directory)),
      ...(trialLog ? { trialLog } : {}),
    };
  }
  if (aggregateTrials.length === 1) {
    return { job, trial: aggregateTrials[0] };
  }
  if (trials.length === 0 && isRecord(job) && job.finished_at === null) {
    throw new IncompleteHarborJobError(`Harbor job ${jobName} has not finished`);
  }
  throw new Error(`expected one Harbor trial result in ${jobDirectory}, found ${trials.length}`);
}

async function readVerifierOutput(
  trialDirectory: string,
): Promise<{ readonly verifier?: HarborVerifierOutput }> {
  const verifierDirectory = join(trialDirectory, "verifier");
  const [combined, stderr] = await Promise.all([
    readBoundedText(join(verifierDirectory, "test-stdout.txt")),
    readBoundedText(join(verifierDirectory, "test-stderr.txt")),
  ]);
  return combined || stderr
    ? { verifier: { ...(combined ? { combined } : {}), ...(stderr ? { stderr } : {}) } }
    : {};
}

/** Harbor copies the task's reward file into result.json, so an oversized one is refused unread. */
async function readResult(directory: string): Promise<string | undefined> {
  const path = join(directory, "result.json");
  const size = await stat(path).then(
    (stats) => stats.size,
    (error: unknown) => (isNotFound(error) ? undefined : Promise.reject(error)),
  );
  if (size === undefined) return undefined;
  if (size > RESULT_MAX_BYTES)
    throw new HarborOutputLimitError(`Harbor result ${path} is larger than 16 MiB`);
  return await readFile(path, "utf8");
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import { readBoundedText } from "../../harnesses/harbor/output-guard.js";
import { tail } from "../../lib/util.js";

/** Which of the two Harbor runs a snapshot belongs to. */
export type HarborLiveRun = "nop" | "oracle";

/** What the task page shows while a Harbor run is in flight. */
export interface HarborLiveSnapshot {
  readonly run: HarborLiveRun;
  readonly startedAt: string;
  readonly capturedAt: string;
  /** Harbor's trial log: one line per milestone (sandbox, image build, services, verifier). */
  readonly steps: string[];
  /** The tail of Harbor's own stdout and stderr. */
  readonly output: string;
}

const INTERVAL_MS = 5_000;
/** Image builds print nothing for minutes; a periodic snapshot shows the run is still alive. */
const HEARTBEAT_MS = 60_000;
const OUTPUT_TAIL = 8_000;
const STEP_LIMIT = 200;
/** Enough of a trial log to hold its last STEP_LIMIT lines. */
const TRIAL_LOG_READ_BYTES = 256 * 1024;

/**
 * Publishes a Harbor run's progress as immutable `<prefix>/live/<attempt>-<run>-<seq>.json`
 * snapshots (the attempt keeps a retried verification's keys fresh and sorting last) so
 * the task page can follow verification before the report exists. Snapshots are observational:
 * a failed write is retried on the next tick and never fails the gate.
 */
export function harborLiveFeed(
  store: ArtifactStore,
  prefix: string,
  run: HarborLiveRun,
  /** This run's own job directory, so the oracle run never shows the nop run's trial log. */
  jobDirectory: string,
  { attempt, secrets }: { readonly attempt: number; readonly secrets: readonly string[] },
) {
  const startedAt = new Date().toISOString();
  let output = "";
  let sequence = 0;
  let previous = "";
  let writtenAt = 0;
  let pending: Promise<void> = Promise.resolve();
  const redact = (text: string) =>
    secrets.reduce((value, secret) => value.split(secret).join("[redacted]"), text);
  const flush = () => {
    pending = pending.then(async () => {
      const steps = (await trialLogs(jobDirectory)).slice(-STEP_LIMIT).map(redact);
      const body = { run, steps, output: redact(tail(output, OUTPUT_TAIL)) };
      const snapshot = JSON.stringify(body);
      if (snapshot === previous && Date.now() - writtenAt < HEARTBEAT_MS) return;
      const key = `${prefix}/live/${String(attempt).padStart(2, "0")}-${run}-${String(sequence).padStart(6, "0")}.json`;
      const live: HarborLiveSnapshot = { ...body, startedAt, capturedAt: new Date().toISOString() };
      await store.put(key, Buffer.from(JSON.stringify(live)), "application/json").then(
        () => {
          previous = snapshot;
          writtenAt = Date.now();
          sequence += 1;
        },
        () => undefined,
      );
    });
    return pending;
  };
  const timer = setInterval(flush, INTERVAL_MS);
  timer.unref();
  return {
    push: (_stream: "stdout" | "stderr", chunk: Uint8Array) => {
      output = (output + Buffer.from(chunk).toString("utf8")).slice(-OUTPUT_TAIL * 2);
    },
    close: async () => {
      clearInterval(timer);
      await flush();
    },
  };
}

/**
 * Each trial's own trial.log under one Harbor job directory, oldest trial first. Deeper files hold
 * sandbox downloads, which may carry the same name.
 */
async function trialLogs(jobDirectory: string): Promise<string[]> {
  const trials = await readdir(jobDirectory, { withFileTypes: true }).catch(() => []);
  const logs = trials
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(entry.name, "trial.log"))
    .sort();
  const lines: string[] = [];
  for (const log of logs) {
    const text = await readBoundedText(join(jobDirectory, log), TRIAL_LOG_READ_BYTES).catch(
      () => undefined,
    );
    lines.push(...(text ?? "").split("\n").filter((line) => line.trim()));
  }
  return lines;
}

/** Credential values Harbor's process holds, so live output never republishes them. */
export function providerSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => /TOKEN|SECRET|KEY/.test(key) && value && value.length >= 8)
    .map(([, value]) => value as string);
}

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
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

/**
 * Publishes a Harbor run's progress as immutable `<prefix>/live/<run>-<seq>.json` snapshots so
 * the task page can follow verification before the report exists. Snapshots are observational:
 * a failed write is retried on the next tick and never fails the gate.
 */
export function harborLiveFeed(
  store: ArtifactStore,
  prefix: string,
  run: HarborLiveRun,
  jobsDirectory: string,
  secrets: readonly string[],
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
      const steps = (await trialLogs(jobsDirectory)).slice(-STEP_LIMIT).map(redact);
      const body = { run, steps, output: redact(tail(output, OUTPUT_TAIL)) };
      const snapshot = JSON.stringify(body);
      if (snapshot === previous && Date.now() - writtenAt < HEARTBEAT_MS) return;
      const key = `${prefix}/live/${run}-${String(sequence).padStart(6, "0")}.json`;
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

/** Every trial log under Harbor's jobs directory, oldest trial first. */
async function trialLogs(jobsDirectory: string): Promise<string[]> {
  const entries = await readdir(jobsDirectory, { recursive: true }).catch(() => []);
  const logs = entries.filter((entry) => entry.endsWith("trial.log")).sort();
  const lines: string[] = [];
  for (const log of logs) {
    const text = await readFile(join(jobsDirectory, log), "utf8").catch(() => "");
    lines.push(...text.split("\n").filter((line) => line.trim()));
  }
  return lines;
}

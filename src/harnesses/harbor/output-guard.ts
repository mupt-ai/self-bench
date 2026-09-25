import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Harbor copies a trial's logs and artifacts from the sandbox onto the worker, and the task's own
 * code decides how large they are. These limits keep one trial from filling the worker's disk
 * (memory on Cloud Run) or its heap.
 */
const HARBOR_OUTPUT_LIMIT_BYTES = 1024 * 1024 * 1024;
const HARBOR_OUTPUT_LIMIT_ENTRIES = 50_000;
/** Largest slice of one sandbox-written log the worker reads into memory. */
const HARBOR_LOG_READ_BYTES = 2 * 1024 * 1024;

export class HarborOutputLimitError extends Error {
  constructor(
    message = `Harbor output exceeded ${HARBOR_OUTPUT_LIMIT_BYTES / 1024 ** 3} GiB or ${HARBOR_OUTPUT_LIMIT_ENTRIES} files on the worker; the trial was stopped`,
  ) {
    super(message);
    this.name = "HarborOutputLimitError";
  }
}

export interface HarborOutputGuard {
  /** Aborts when the watched directories grow past the limit, or when `parent` aborts. */
  readonly signal: AbortSignal;
  /**
   * Settles with `work` (the Harbor process, run with `signal`) and stops polling; a run the guard
   * cut short, or that finished past the limit, rejects with HarborOutputLimitError instead.
   */
  watch<T>(work: Promise<T>): Promise<T>;
}

/**
 * Polls the directories Harbor writes into and aborts the run once they pass the size or file
 * limit. A single large download can overshoot by one poll interval before the abort lands.
 */
export function guardHarborOutput(
  directories: readonly string[],
  parent?: AbortSignal,
  options: { limitBytes?: number; limitEntries?: number; intervalMs?: number } = {},
): HarborOutputGuard {
  const limitBytes = options.limitBytes ?? HARBOR_OUTPUT_LIMIT_BYTES;
  const limitEntries = options.limitEntries ?? HARBOR_OUTPUT_LIMIT_ENTRIES;
  const controller = new AbortController();
  let exceeded: HarborOutputLimitError | undefined;
  let measuring = false;
  const over = async () => {
    const usage = await measure(directories, limitBytes, limitEntries);
    return usage.bytes > limitBytes || usage.entries > limitEntries;
  };
  const timer = setInterval(() => {
    if (measuring || exceeded) return;
    measuring = true;
    void over()
      .then((isOver) => {
        if (!isOver || exceeded) return;
        exceeded = new HarborOutputLimitError();
        controller.abort(exceeded);
      })
      .finally(() => {
        measuring = false;
      });
  }, options.intervalMs ?? 2_000);
  timer.unref();
  return {
    signal: parent ? AbortSignal.any([parent, controller.signal]) : controller.signal,
    async watch(work) {
      try {
        const value = await work.catch((error: unknown) => {
          throw exceeded ?? error;
        });
        // A burst in the last poll interval lands after the final poll; measure once more.
        if (exceeded || (await over())) throw exceeded ?? new HarborOutputLimitError();
        return value;
      } finally {
        clearInterval(timer);
      }
    },
  };
}

async function measure(
  directories: readonly string[],
  limitBytes: number,
  limitEntries: number,
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  for (const directory of directories) {
    const listed = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of listed) {
      entries += 1;
      if (entries > limitEntries) return { bytes, entries };
      if (!entry.isFile()) continue;
      bytes += await lstat(join(entry.parentPath, entry.name)).then(
        (stats) => stats.size,
        () => 0,
      );
      if (bytes > limitBytes) return { bytes, entries };
    }
  }
  return { bytes, entries };
}

/**
 * A sandbox-written text file, whole when small; otherwise its first and last halves of `limit`
 * bytes around a marker. Missing files read as undefined; links are refused.
 */
export async function readBoundedText(
  path: string,
  limit = HARBOR_LOG_READ_BYTES,
): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(
    (error: unknown) =>
      (error as { code?: unknown }).code === "ENOENT" ? undefined : Promise.reject(error),
  );
  if (!file) return undefined;
  try {
    const { size } = await file.stat();
    if (size <= limit) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }
    const half = Math.floor(limit / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const [first, last] = await Promise.all([
      file.read(head, 0, half, 0),
      file.read(tail, 0, half, size - half),
    ]);
    return `${head.subarray(0, first.bytesRead).toString("utf8")}\n[… ${size - 2 * half} bytes omitted …]\n${tail.subarray(0, last.bytesRead).toString("utf8")}`;
  } finally {
    await file.close();
  }
}

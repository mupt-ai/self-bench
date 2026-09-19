import { expect, test } from "bun:test";
import { readE2BOutput } from "../../../../src/sandbox/providers/e2b/output-read.js";
import type { E2BSandboxHandle } from "../../../../src/sandbox/providers/e2b/types.js";

test("archive reads share a bound while control files and queued cancellation remain responsive", async () => {
  const started: string[] = [];
  const releases = new Map<string, (error?: Error) => void>();
  const sandbox = {
    files: {
      read: async (path: string) => {
        started.push(path);
        if (path.endsWith(".tar.gz")) {
          await new Promise<void>((resolve, reject) => {
            releases.set(path, (error) => (error ? reject(error) : resolve()));
          });
        }
        return Buffer.from(path);
      },
    },
  } as unknown as E2BSandboxHandle;
  const signal = new AbortController().signal;
  const cancelled = new AbortController();
  const first = readE2BOutput(sandbox, "one.tar.gz", signal);
  const second = readE2BOutput(sandbox, "two.tar.gz", signal);
  const third = readE2BOutput(sandbox, "cancelled.tar.gz", cancelled.signal);
  const fourth = readE2BOutput(sandbox, "four.tar.gz", signal);
  const failed = first.catch((error: Error) => error);
  const aborted = third.catch((error: Error) => error);
  try {
    expect(started).toEqual(["one.tar.gz", "two.tar.gz"]);
    expect(await readE2BOutput(sandbox, "material.json", signal)).toEqual(
      Buffer.from("material.json"),
    );
    cancelled.abort(new Error("cancelled while queued"));
    expect(await aborted).toEqual(new Error("cancelled while queued"));
    releases.get("one.tar.gz")?.(new Error("read failed"));
    expect(await failed).toEqual(new Error("read failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual(["one.tar.gz", "two.tar.gz", "material.json", "four.tar.gz"]);
    releases.get("two.tar.gz")?.();
    releases.get("four.tar.gz")?.();
    expect(await second).toEqual(Buffer.from("two.tar.gz"));
    expect(await fourth).toEqual(Buffer.from("four.tar.gz"));
  } finally {
    cancelled.abort(new Error("test cleanup"));
    for (const release of releases.values()) release();
    await Promise.allSettled([first, second, third, fourth]);
  }
});

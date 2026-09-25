import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../src/lib/hash.js";
import { runCommand } from "../src/lib/process.js";
import { remoteFileFetchScript } from "../src/sandbox/remote-files.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A source file and a not-yet-existing destination, both under paths that contain a quote. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "selfbench-remote-files-"));
  roots.push(root);
  const source = join(root, "bucket's", "bundle.tar.gz");
  await mkdir(join(root, "bucket's"));
  await writeFile(source, "bundle bytes\n");
  return { source, destination: join(root, "work's", "nested", "task.tar.gz") };
}

const fetchWith = (source: string, destination: string, digest: string) =>
  runCommand(
    "bash",
    ["-c", remoteFileFetchScript({ path: destination, url: `file://${source}`, sha256: digest })],
    { allowFailure: true },
  );

describe("remote sandbox files", () => {
  test("the in-sandbox fetch script downloads into new directories when the digest matches", async () => {
    const { source, destination } = await fixture();
    const result = await fetchWith(source, destination, sha256("bundle bytes\n"));
    expect(result.exitCode).toBe(0);
    expect(await readFile(destination, "utf8")).toBe("bundle bytes\n");
  });

  test("the in-sandbox fetch script fails when the downloaded bytes do not match the digest", async () => {
    const { source, destination } = await fixture();
    expect((await fetchWith(source, destination, sha256("other bytes\n"))).exitCode).not.toBe(0);
  });

  test("the in-sandbox fetch script retries transient download failures", () => {
    const script = remoteFileFetchScript({ path: "/work/a", url: "https://x", sha256: "0" });
    expect(script).toContain("--retry 5 --retry-all-errors");
  });
});

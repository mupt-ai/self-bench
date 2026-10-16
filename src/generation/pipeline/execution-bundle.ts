import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { pack } from "tar-stream";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTask } from "../../contracts/index.js";
import { sha256 } from "../../lib/hash.js";
import { unpackTask } from "./remote-gate.js";

const EXECUTION_BUNDLE_NAME = "execution-task.tar.gz";
const REQUIRED_FILES = [
  "instruction.md",
  "task.toml",
  "tests/test.sh",
  "tests/test.patch",
  "solution/solve.sh",
  "solution/gold.patch",
];

/**
 * The compiler's build inputs remain immutable provenance. Once both verified images are
 * exported, the delivered task needs only native Harbor files and digest-backed Dockerfiles.
 * Hidden tests stay in the separate verifier; neither tests nor solution enter the agent build.
 */
export async function publishExecutionBundle(
  store: ArtifactStore,
  task: AuthoredTask,
  signal: AbortSignal,
): Promise<AuthoredTask> {
  const images = task.images?.registry;
  if (!images?.agent || !images.verifier) return task;
  if (task.bundle.uri.endsWith(`/${EXECUTION_BUNDLE_NAME}`)) return task;
  const runIndex = task.bundle.uri.indexOf("/runs/");
  if (runIndex < 0) throw new Error("Execution bundle must belong to a generation run");
  const prefix = dirname(task.bundle.uri.slice(runIndex + 1));
  const root = await mkdtemp(join(tmpdir(), "selfbench-execution-bundle-"));
  try {
    await mkdir(join(root, "source"));
    const source = await unpackTask(store, task.bundle, join(root, "source"), signal);
    const output = join(root, "delivered", "harbor-task");
    for (const file of REQUIRED_FILES) {
      await mkdir(dirname(join(output, file)), { recursive: true });
      await cp(join(source, file), join(output, file));
    }
    for (const [context, image] of [
      ["environment", images.agent],
      ["tests", images.verifier],
    ] as const) {
      if (!/^[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(image))
        throw new Error(`Invalid ${context} image digest`);
      await mkdir(join(output, context), { recursive: true });
      await writeFile(join(output, context, "Dockerfile"), `FROM ${image}\n`);
      // Service declarations remain native Harbor build context, with the image supplying main.
      const compose = await readFile(join(source, context, "docker-compose.yaml"), "utf8").catch(
        (error) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        },
      );
      if (compose !== undefined)
        await writeFile(join(output, context, "docker-compose.yaml"), compose);
    }
    const files = [...REQUIRED_FILES, "environment/Dockerfile", "tests/Dockerfile"];
    for (const context of ["environment", "tests"]) {
      const compose = `${context}/docker-compose.yaml`;
      if (
        await readFile(join(output, compose)).then(
          () => true,
          () => false,
        )
      )
        files.push(compose);
    }
    const bytes = await executionArchive(output, files);
    // Content-derived keys and deterministic archives make concurrent activity retries safe.
    const revision = sha256(
      JSON.stringify([task.bundle.sha256, images.agent, images.verifier]),
    ).slice(0, 24);
    const key = `${prefix}/execution-${revision}/${EXECUTION_BUNDLE_NAME}`;
    const existing = await store.stat(key);
    const bundle = existing
      ? { ...existing, contentType: "application/gzip" }
      : await store.put(key, bytes, "application/gzip");
    return { ...task, bundle };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function executionArchive(directory: string, files: string[]): Promise<Buffer> {
  const archive = pack();
  const chunks: Buffer[] = [];
  const reading = (async () => {
    for await (const chunk of archive) chunks.push(Buffer.from(chunk));
  })();
  let size = 0;
  try {
    for (const file of files.sort()) {
      const bytes = await readFile(join(directory, file));
      size += bytes.length;
      if (size > 32 * 1024 * 1024) throw new Error("Execution task exceeds 32 MiB");
      await new Promise<void>((resolve, reject) => {
        archive.entry(
          {
            name: `harbor-task/${file}`,
            size: bytes.length,
            mode: file.endsWith(".sh") ? 0o755 : 0o644,
            mtime: new Date(0),
            uid: 0,
            gid: 0,
          },
          bytes,
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }
    archive.finalize();
    await reading;
    return gzipSync(Buffer.concat(chunks));
  } catch (error) {
    archive.destroy();
    await reading.catch(() => {});
    throw error;
  }
}

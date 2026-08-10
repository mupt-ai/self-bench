import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  GcsArtifactStore,
  LocalArtifactStore,
  verifiedArtifactReadStream,
} from "../src/artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LocalArtifactStore", () => {
  test("writes content-addressed references and verifies reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-artifacts-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);
    const first = await store.put(
      "runs/example/value.json",
      Buffer.from("one"),
      "application/json",
    );
    const second = await store.put(
      "runs/example/value.json",
      Buffer.from("one"),
      "application/json",
    );

    expect(second).toEqual(first);
    expect(Buffer.from(await store.get(first)).toString("utf8")).toBe("one");
    expect(
      Buffer.from((await store.getByKey("runs/example/value.json")) ?? []).toString("utf8"),
    ).toBe("one");
    expect(await store.getByKey("runs/example/missing.json")).toBeUndefined();
    await expect(
      store.put("runs/example/value.json", Buffer.from("two"), "application/json"),
    ).rejects.toThrow();
  });

  test("publishes and streams file-backed artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-artifacts-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);
    const source = join(root, "source.tar.gz");
    await writeFile(source, Buffer.from("streamed archive"));

    const first = await store.putFile("runs/example/export.tar.gz", source, "application/gzip");
    const second = await store.putFile("runs/example/export.tar.gz", source, "application/gzip");
    await writeFile(source, Buffer.from("mutated source"));
    const chunks: Buffer[] = [];
    for await (const chunk of await store.openRead(first)) {
      chunks.push(Buffer.from(chunk));
    }

    expect(second).toEqual(first);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("streamed archive");
    const conflictingSource = join(root, "conflicting.tar.gz");
    await writeFile(conflictingSource, Buffer.from("different archive"));
    await expect(
      store.putFile("runs/example/export.tar.gz", conflictingSource, "application/gzip"),
    ).rejects.toThrow("different contents");
    await expect(store.openRead({ ...first, sizeBytes: first.sizeBytes + 1 })).rejects.toThrow(
      "integrity check failed",
    );
  });

  test("rejects keys that escape the artifact root", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-artifacts-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);

    await expect(store.put("../escape", Buffer.from("x"), "text/plain")).rejects.toThrow("unsafe");
  });
});

test("verified artifact streams propagate source read failures", async () => {
  const source = new Readable({
    read() {
      this.destroy(new Error("source read failed"));
    },
  });
  const output = verifiedArtifactReadStream(
    {
      uri: "file:///artifact",
      sha256: "a".repeat(64),
      sizeBytes: 1,
      contentType: "application/octet-stream",
    },
    source,
  );

  await expect(
    (async () => {
      for await (const _chunk of output) {
        // Consume the stream to surface its source error.
      }
    })(),
  ).rejects.toThrow("source read failed");
});

describe("GcsArtifactStore", () => {
  test("rejects references outside the configured object prefix", async () => {
    const store = new GcsArtifactStore("private-benchmarks", "selfbench");

    await expect(
      store.get({
        uri: "gs://private-benchmarks/unrelated/secret.json",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        contentType: "application/json",
      }),
    ).rejects.toThrow("outside configured bucket");
  });
});

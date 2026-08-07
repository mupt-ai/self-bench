import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GcsArtifactStore, LocalArtifactStore } from "../src/artifacts.js";

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

  test("rejects keys that escape the artifact root", async () => {
    const root = await mkdtemp(join(tmpdir(), "selfbench-artifacts-"));
    roots.push(root);
    const store = new LocalArtifactStore(root);

    await expect(store.put("../escape", Buffer.from("x"), "text/plain")).rejects.toThrow("unsafe");
  });
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

import { describe, expect, test } from "bun:test";
import { sha256 } from "../src/hash.js";
import { taskState } from "../src/site/tasks.js";
import { packageUpload, readUploadArchive, UPLOAD_LIMITS } from "../src/site/upload-archive.js";
import { uploadPreview } from "../src/site/upload-store.js";
import { validateUpload } from "../src/site/upload-validate.js";
import { archive, harborFiles } from "./support/upload-fixture.js";

const read = (bytes: Buffer) => readUploadArchive(bytes, { bytes: 0, entries: 0 });
describe("non-executing upload archives", () => {
  test("single root, wrapped and multiple ordinary Harbor tasks", async () => {
    for (const root of ["", "harbor-task/", "dataset/alpha/"]) {
      const result = await validateUpload(await archive(harborFiles(root)));
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.errors).toEqual([]);
      expect(result.tasks[0]?.metadata.harbor).toMatchObject({
        metadata: { custom: "preserve me" },
      });
    }
    expect(
      (await validateUpload(await archive([...harborFiles(), ...harborFiles("beta/")], false)))
        .tasks,
    ).toHaveLength(2);
  });
  test("SelfBench wrappers preserve arbitrary metadata, checksum and missing checksums", async () => {
    const task = await archive(harborFiles("harbor-task/"));
    for (const checksum of [sha256(task), undefined]) {
      const manifest = {
        schemaVersion: 1,
        runId: "untrusted-run",
        extra: { score: 100 },
        tasks: [{ taskId: "alpha", sha256: checksum, extra: "yes" }],
      };
      const result = await validateUpload(
        await archive([
          { name: "export/manifest.json", text: JSON.stringify(manifest) },
          { name: "export/tasks/alpha.tar.gz", text: task },
        ]),
      );
      expect(result.tasks[0]?.errors).toEqual([]);
      expect(result.manifest?.extra).toEqual({ score: 100 });
      expect(result.tasks[0]?.metadata.exportTask).toMatchObject({ extra: "yes" });
    }
  });
  test("malformed tasks, duplicate identities/content and mismatched checksums are previewed", async () => {
    const result = await validateUpload(
      await archive([
        ...harborFiles(),
        ...harborFiles("b/alpha/"),
        { name: "bad/task.toml", text: "nonsense = [" },
      ]),
    );
    const preview = uploadPreview(result.tasks, []);
    expect(preview[1]?.conflicts.length).toBeGreaterThan(0);
    expect(preview[2]?.errors.length).toBeGreaterThan(0);
    const wrapped = await validateUpload(
      await archive([
        {
          name: "manifest.json",
          text: JSON.stringify({ tasks: [{ taskId: "alpha", sha256: "0".repeat(64) }] }),
        },
        { name: "tasks/alpha.tar.gz", text: await archive(harborFiles()) },
      ]),
    );
    expect(wrapped.tasks[0]?.errors).toContain("Manifest checksum mismatch");
  });
  test("reject paths, links, devices, repeated paths and collisions", async () => {
    for (const name of ["../escape", "/absolute", "C:/drive", "a\\b", "a/../b", "a\nb"])
      await expect(read(await archive([{ name, text: "x" }]))).rejects.toThrow();
    for (const type of ["symlink", "link", "fifo", "character-device"] as const)
      await expect(
        read(await archive([{ name: "bad", type, linkname: "../escape" }])),
      ).rejects.toThrow();
    await expect(
      read(
        await archive([
          { name: "a", text: "x" },
          { name: "./a", text: "y" },
        ]),
      ),
    ).rejects.toThrow("Repeated");
    await expect(
      read(
        await archive([
          { name: "a", text: "x" },
          { name: "a/b", text: "y" },
        ]),
      ),
    ).rejects.toThrow("collision");
  });
  test("compressed/expanded/entry budgets and truncated input fail closed", async () => {
    await expect(read(Buffer.alloc(UPLOAD_LIMITS.compressed + 1))).rejects.toThrow("compressed");
    const bytes = await archive(harborFiles());
    await expect(
      readUploadArchive(bytes, { bytes: UPLOAD_LIMITS.expanded - 1, entries: 0 }),
    ).rejects.toThrow("expanded");
    await expect(
      readUploadArchive(bytes, { bytes: 0, entries: UPLOAD_LIMITS.entries }),
    ).rejects.toThrow("entries");
    await expect(read(bytes.subarray(0, -12))).rejects.toThrow();
    await expect(read(Buffer.from("not tar"))).rejects.toThrow();
  });
  test("task-local SelfBench manifest checksums are validated and metadata retained", async () => {
    const definition = { environment: { image: "scratch" }, custom: "keep" };
    const manifest = {
      taskId: "original-id",
      definitionSha256: sha256(JSON.stringify(definition)),
      environmentSha256: sha256(JSON.stringify(definition.environment)),
      testPatchSha256: sha256("test patch"),
      goldPatchSha256: sha256("gold patch"),
      extra: "keep",
    };
    const files = [
      ...harborFiles(),
      { name: "alpha/definition.json", text: JSON.stringify(definition) },
      { name: "alpha/tests/test.patch", text: "test patch" },
      { name: "alpha/solution/gold.patch", text: "gold patch" },
    ];
    const valid = await validateUpload(
      await archive([
        ...files,
        { name: "alpha/.selfbench-manifest.json", text: JSON.stringify(manifest) },
      ]),
    );
    expect(valid.tasks[0]?.errors).toEqual([]);
    expect(valid.tasks[0]?.taskId).toBe("original-id");
    expect(valid.tasks[0]?.metadata.selfbenchManifest).toMatchObject({ extra: "keep" });
    const invalid = await validateUpload(
      await archive([
        ...files,
        {
          name: "alpha/.selfbench-manifest.json",
          text: JSON.stringify({ ...manifest, testPatchSha256: "wrong" }),
        },
      ]),
    );
    expect(invalid.tasks[0]?.errors).toContain("Task manifest checksum mismatch: testPatchSha256");
  });
  test("repackage is viewer-compatible and human approval never changes upload pipeline status", async () => {
    const task = (await validateUpload(await archive(harborFiles()))).tasks[0];
    if (!task) throw new Error("task missing");
    const packed = await read(await packageUpload(task.files));
    expect(packed.has("harbor-task/task.toml")).toBe(true);
    expect(taskState({ pipelineStatus: "uploaded" })).toBe("uploaded");
    expect(taskState({ pipelineStatus: "uploaded", review: { decision: "approve" } })).toBe(
      "accepted",
    );
  });
});

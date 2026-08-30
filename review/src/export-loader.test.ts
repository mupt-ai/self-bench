import { describe, expect, test } from "bun:test";
import { buildCleanExport, loadExport } from "./export-loader";
import type { LoadedExport } from "./types";

describe("export review bundles", () => {
  test("round-trips nested task archives and removes marked tasks", async () => {
    const loaded: LoadedExport = {
      manifest: {
        schemaVersion: 1,
        runId: "run-123",
        candidateCounts: { easy: 2, medium: 0, hard: 0 },
        repository: { url: "https://github.com/example/repo", commit: "a".repeat(40) },
        version: { schema: 1 },
        acceptedCount: 2,
        tasks: [],
      },
      tasks: [],
      taskArchives: new Map([
        ["task-a", await taskArchive("task-a")],
        ["task-b", await taskArchive("task-b")],
      ]),
    };
    loaded.manifest.tasks = await Promise.all(
      [...loaded.taskArchives].map(async ([taskId, archive]) => ({
        taskId,
        sha256: await digest(archive),
      })),
    );
    loaded.tasks = [
      { taskId: "task-a", files: new Map(), textFiles: new Map() },
      { taskId: "task-b", files: new Map(), textFiles: new Map() },
    ];

    const cleaned = await buildCleanExport(loaded, new Set(["task-b"]));
    const result = await loadExport(cleaned);

    expect(result.manifest.acceptedCount).toBe(1);
    expect(result.manifest.tasks.map((task) => task.taskId)).toEqual(["task-a"]);
    expect(result.tasks[0]?.textFiles.get("definition.json")).toBe('{"taskId":"task-a"}');
  });
});

async function digest(value: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function taskArchive(taskId: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(JSON.stringify({ taskId }));
  const header = new Uint8Array(512);
  write(header, 0, "harbor-task/definition.json");
  write(header, 124, data.length.toString(8).padStart(11, "0"));
  header[156] = 48;
  const tar = new Uint8Array(512 + Math.ceil(data.length / 512) * 512 + 1024);
  tar.set(header);
  tar.set(data, 512);
  const compressed = await new Response(
    new Blob([tar.buffer]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

function write(target: Uint8Array, offset: number, value: string): void {
  target.set(new TextEncoder().encode(value), offset);
}

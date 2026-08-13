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
        tasks: [
          { taskId: "task-a", sha256: "a".repeat(64) },
          { taskId: "task-b", sha256: "b".repeat(64) },
        ],
      },
      tasks: [],
      taskArchives: new Map([
        ["task-a", await taskArchive("task-a")],
        ["task-b", await taskArchive("task-b")],
      ]),
    };
    loaded.tasks = [
      { taskId: "task-a", files: new Map(), textFiles: new Map() },
      { taskId: "task-b", files: new Map(), textFiles: new Map() },
    ];

    const cleaned = await buildCleanExport(loaded, new Set(["task-b"]));
    const result = await loadExport(cleaned);

    expect(result.manifest.acceptedCount).toBe(1);
    expect(result.manifest.tasks.map((task) => task.taskId)).toEqual(["task-a"]);
    expect(result.tasks[0]?.textFiles.get(".selfbench-manifest.json")).toBe(
      '{"taskId":"task-a","difficulty":"easy"}',
    );
    expect(result.tasks[0]?.textFiles.get("instruction.md")).toBe("Review task-a");
    expect(result.tasks[0]?.textFiles.get("task.toml")).toBe('version = "1.0"');
  });
});

async function taskArchive(taskId: string): Promise<Uint8Array> {
  const entries = [
    ["harbor-task/.selfbench-manifest.json", JSON.stringify({ taskId, difficulty: "easy" })],
    ["harbor-task/instruction.md", `Review ${taskId}`],
    ["harbor-task/task.toml", 'version = "1.0"'],
  ];
  const chunks: Uint8Array[] = [];
  for (const [name, value] of entries) {
    const data = new TextEncoder().encode(value);
    const header = new Uint8Array(512);
    write(header, 0, name);
    write(header, 124, data.length.toString(8).padStart(11, "0"));
    header[156] = 48;
    const chunk = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
    chunk.set(header);
    chunk.set(data, 512);
    chunks.push(chunk);
  }
  const tar = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 1024));
  let offset = 0;
  for (const chunk of chunks) {
    tar.set(chunk, offset);
    offset += chunk.length;
  }
  const compressed = await new Response(
    new Blob([tar.buffer]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}

function write(target: Uint8Array, offset: number, value: string): void {
  target.set(new TextEncoder().encode(value), offset);
}

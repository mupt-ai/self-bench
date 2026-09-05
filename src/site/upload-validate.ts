import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import { sha256 } from "../hash.js";
import {
  type ArchiveBudget,
  readUploadArchive,
  UPLOAD_LIMITS,
  UploadError,
} from "./upload-archive.js";

export interface UploadTask {
  taskId: string;
  digest: string;
  difficulty: "easy" | "medium" | "hard" | "unknown";
  metadata: Record<string, unknown>;
  files: Map<string, Buffer>;
  errors: string[];
}
export interface ValidatedUpload {
  tasks: UploadTask[];
  manifest?: Record<string, unknown>;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export async function validateUpload(bytes: Buffer): Promise<ValidatedUpload> {
  const budget: ArchiveBudget = { bytes: 0, entries: 0 };
  const files = await readUploadArchive(bytes, budget);
  const manifestPaths = [...files.keys()].filter((path) => /(^|\/)manifest.json$/.test(path));
  // A SelfBench wrapper has a manifest beside tasks/<id>.tar.gz; task-local metadata is not a wrapper.
  const wrapper = manifestPaths.find((path) =>
    [...files.keys()].some(
      (key) => key.startsWith(`${path.slice(0, -13)}tasks/`) && key.endsWith(".tar.gz"),
    ),
  );
  if (!wrapper) return { tasks: discover(files) };
  let manifest: unknown;
  try {
    manifest = JSON.parse(files.get(wrapper)?.toString("utf8") ?? "");
  } catch {
    throw new UploadError("Invalid export manifest JSON");
  }
  if (
    !object(manifest) ||
    !Array.isArray(manifest.tasks) ||
    manifest.tasks.length > UPLOAD_LIMITS.tasks
  )
    throw new UploadError("Invalid export manifest tasks");
  const tasks: UploadTask[] = [];
  const prefix = wrapper.slice(0, -13);
  const declared = new Set<string>();
  for (const entry of manifest.tasks) {
    if (!object(entry) || typeof entry.taskId !== "string" || !ID.test(entry.taskId))
      throw new UploadError("Invalid manifest task ID");
    const path = `${prefix}tasks/${entry.taskId}.tar.gz`;
    const data = files.get(path);
    const errors: string[] = [];
    if (declared.has(path)) errors.push("Duplicate manifest task ID");
    declared.add(path);
    if (!data) errors.push("Missing task archive");
    if (
      entry.sha256 !== undefined &&
      (typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/i.test(entry.sha256) ||
        !data ||
        sha256(data) !== entry.sha256.toLowerCase())
    )
      errors.push("Manifest checksum mismatch");
    let task: UploadTask | undefined;
    if (data && !errors.length) {
      try {
        const found = discover(await readUploadArchive(data, budget));
        if (found.length !== 1) errors.push("Expected exactly one task in wrapper entry");
        else task = found[0];
      } catch (error) {
        errors.push(error instanceof Error ? error.message : "Invalid task archive");
      }
    }
    tasks.push({
      ...(task ?? emptyTask(entry.taskId)),
      taskId: entry.taskId,
      metadata: { ...task?.metadata, exportTask: entry },
      errors: [...(task?.errors ?? []), ...errors],
    });
  }
  for (const path of files.keys())
    if (path.startsWith(`${prefix}tasks/`) && path.endsWith(".tar.gz") && !declared.has(path))
      tasks.push({ ...emptyTask(path), errors: ["Task archive not declared in manifest"] });
  if (!tasks.length) throw new UploadError("No tasks in export");
  return { tasks, manifest };
}

function emptyTask(taskId: string): UploadTask {
  return { taskId, digest: "", difficulty: "unknown", metadata: {}, files: new Map(), errors: [] };
}

function discover(files: Map<string, Buffer>): UploadTask[] {
  const roots = new Set<string>();
  for (const path of files.keys()) {
    if (/(^|\/)(task.toml|instruction.md)$/.test(path))
      roots.add(path.slice(0, path.lastIndexOf("/") + 1));
  }
  if (!roots.size)
    throw new UploadError("No Harbor tasks found (task.toml and instruction.md required)");
  if (roots.size > UPLOAD_LIMITS.tasks) throw new UploadError("Too many tasks (maximum 200)");
  return [...roots].sort().map((root) => {
    const content = new Map(
      [...files]
        .filter(([path]) => path.startsWith(root))
        .map(([path, data]) => [path.slice(root.length), data]),
    );
    const segments = root.split("/").filter(Boolean);
    const id =
      segments.at(-1) === "harbor-task"
        ? (segments.at(-2) ?? "harbor-task")
        : (segments.at(-1) ?? "task");
    const task = { ...emptyTask(id), files: content };
    if (!ID.test(id))
      task.errors.push("Task folder name must use letters, numbers, dots, underscores or hyphens");
    if ([...roots].some((other) => other !== root && other.startsWith(root)))
      task.errors.push("Nested task directories are ambiguous");
    for (const required of ["task.toml", "instruction.md", "tests/test.sh"])
      if (!content.get(required)?.length) task.errors.push(`Missing or empty ${required}`);
    if (![...content.keys()].some((path) => path.startsWith("environment/")))
      task.errors.push("Missing environment files");
    try {
      const config = parse(content.get("task.toml")?.toString("utf8") ?? "");
      if (config.version !== "1.0") task.errors.push("task.toml version must be 1.0");
      task.metadata = { harbor: config };
      const metadata = config.metadata;
      const difficulty = object(metadata) ? metadata.difficulty : undefined;
      if (difficulty === "easy" || difficulty === "medium" || difficulty === "hard")
        task.difficulty = difficulty;
    } catch {
      task.errors.push("Invalid task.toml");
    }
    const definition = content.get("task.json") ?? content.get("definition.json");
    if (definition) {
      try {
        const parsed: unknown = JSON.parse(definition.toString("utf8"));
        if (object(parsed)) task.metadata.definition = parsed;
        else task.errors.push("Invalid task definition JSON");
      } catch {
        task.errors.push("Invalid task definition JSON");
      }
    }
    const hash = createHash("sha256");
    for (const [path, data] of [...content].sort(([a], [b]) => a.localeCompare(b)))
      hash.update(JSON.stringify([path, data.length])).update(data);
    validateTaskManifest(task);
    task.digest = hash.digest("hex");
    return task;
  });
}

function validateTaskManifest(task: UploadTask): void {
  const bytes = task.files.get(".selfbench-manifest.json");
  if (!bytes) return;
  try {
    const manifest: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(manifest)) throw new Error("invalid");
    task.metadata.selfbenchManifest = manifest;
    if (typeof manifest.taskId === "string" && ID.test(manifest.taskId))
      task.taskId = manifest.taskId;
    const definition = task.metadata.definition;
    const hashes: Record<string, string | undefined> = {
      definitionSha256: object(definition) ? sha256(JSON.stringify(definition)) : undefined,
      environmentSha256:
        object(definition) && definition.environment !== undefined
          ? sha256(JSON.stringify(definition.environment))
          : undefined,
      testPatchSha256: task.files.has("tests/test.patch")
        ? sha256(task.files.get("tests/test.patch") ?? Buffer.alloc(0))
        : undefined,
      goldPatchSha256: task.files.has("solution/gold.patch")
        ? sha256(task.files.get("solution/gold.patch") ?? Buffer.alloc(0))
        : undefined,
    };
    for (const [key, actual] of Object.entries(hashes)) {
      if (
        manifest[key] !== undefined &&
        (typeof manifest[key] !== "string" || actual !== manifest[key])
      )
        task.errors.push(`Task manifest checksum mismatch: ${key}`);
    }
  } catch {
    task.errors.push("Invalid .selfbench-manifest.json");
  }
}

import type { ExportManifest, ExportTask, LoadedExport } from "./types";

const textNames = new Set([
  "definition.json",
  "instruction.md",
  "task.toml",
  ".selfbench-manifest.json",
  "solution/gold.patch",
  "tests/test.patch",
  "tests/dependency-setup.patch",
]);

interface TarEntry {
  name: string;
  data: Uint8Array;
}

export async function loadExport(input: Blob | Uint8Array): Promise<LoadedExport> {
  const archive = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
  const outerEntries = untar(await gunzip(archive));
  const manifestBytes = outerEntries.find((entry) => entry.name === "manifest.json")?.data;
  if (!manifestBytes) throw new Error("export is missing manifest.json");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ExportManifest;
  const tasks: ExportTask[] = [];
  const taskArchives = new Map<string, Uint8Array>();
  for (const manifestTask of manifest.tasks) {
    const name = `tasks/${manifestTask.taskId}.tar.gz`;
    const archiveEntry = outerEntries.find((entry) => entry.name === name);
    if (!archiveEntry) throw new Error(`export is missing ${name}`);
    if ((await sha256(archiveEntry.data)) !== manifestTask.sha256) {
      throw new Error(`export task ${manifestTask.taskId} failed its SHA-256 integrity check`);
    }
    taskArchives.set(manifestTask.taskId, archiveEntry.data);
    const entries = untar(await gunzip(archiveEntry.data));
    const files = new Map<string, Uint8Array>();
    const textFiles = new Map<string, string>();
    for (const entry of entries) {
      const relative = entry.name.replace(/^harbor-task\//, "");
      if (!relative || entry.name.endsWith("/")) continue;
      files.set(relative, entry.data);
      if (textNames.has(relative) || relative.endsWith(".json")) {
        textFiles.set(relative, new TextDecoder().decode(entry.data));
      }
    }
    tasks.push({ taskId: manifestTask.taskId, files, textFiles });
  }
  return { manifest, tasks, taskArchives };
}

export async function buildCleanExport(
  loaded: LoadedExport,
  removedTaskIds: Set<string>,
): Promise<Blob> {
  const keptIds = new Set(
    loaded.tasks.filter((task) => !removedTaskIds.has(task.taskId)).map((task) => task.taskId),
  );
  const manifest: ExportManifest = {
    ...loaded.manifest,
    acceptedCount: keptIds.size,
    tasks: loaded.manifest.tasks.filter((task) => keptIds.has(task.taskId)),
  };
  const entries: TarEntry[] = [
    {
      name: "manifest.json",
      data: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`),
    },
  ];
  for (const task of loaded.tasks) {
    if (keptIds.has(task.taskId)) {
      const archive = loaded.taskArchives.get(task.taskId);
      if (!archive) throw new Error(`loaded export is missing ${task.taskId}`);
      entries.push({ name: `tasks/${task.taskId}.tar.gz`, data: archive });
    }
  }
  return gzip(tar(entries));
}

async function gunzip(value: Uint8Array): Promise<Uint8Array> {
  return transform(value, new DecompressionStream("gzip"), 1024 * 1024 * 1024);
}

async function gzip(value: Uint8Array): Promise<Blob> {
  const compressed = await transform(value, new CompressionStream("gzip"));
  return new Blob([compressed.buffer as ArrayBuffer], { type: "application/gzip" });
}

async function transform(
  value: Uint8Array,
  stream: TransformStream,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const reader = new Blob([Uint8Array.from(value)]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error(`archive expands beyond ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function untar(buffer: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = [];
  const names = new Set<string>();
  for (let offset = 0; offset + 512 <= buffer.length; ) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readString(header, 0, 100);
    const size = parseOctal(header, 124, 12);
    const type = header[156];
    if (!safeTarPath(name) || names.has(name)) throw new Error(`unsafe tar entry: ${name}`);
    names.add(name);
    offset += 512;
    const paddedSize = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(size) || size < 0 || offset + paddedSize > buffer.length) {
      throw new Error(`invalid tar entry size for ${name}`);
    }
    const data = buffer.slice(offset, offset + size);
    if (type !== 5 && name) entries.push({ name, data });
    offset += paddedSize;
  }
  return entries;
}

function tar(entries: TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeString(header, 0, 100, entry.name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.length);
    writeOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(32, 148, 156);
    header[156] = 48;
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, entry.data, new Uint8Array((512 - (entry.data.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

async function sha256(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeTarPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => part === "..")
  );
}

function readString(bytes: Uint8Array, start: number, length: number): string {
  const field = bytes.subarray(start, start + length);
  const end = field.indexOf(0);
  return new TextDecoder().decode(end < 0 ? field : field.subarray(0, end));
}

function parseOctal(bytes: Uint8Array, start: number, length: number): number {
  const value = readString(bytes, start, length).trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function writeString(bytes: Uint8Array, start: number, length: number, value: string): void {
  bytes.set(new TextEncoder().encode(value).subarray(0, length), start);
}

function writeOctal(bytes: Uint8Array, start: number, length: number, value: number): void {
  writeString(bytes, start, length, value.toString(8).padStart(length - 1, "0"));
}

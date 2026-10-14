import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DARI_REQUEST_IDS } from "../src/evaluation/dari/cost.js";
import { retainDariManifest } from "../src/evaluation/dari/manifest.js";
import { TRUNCATED_OUTPUT } from "../src/evaluation/output.js";

const path = "solver/task/agent/pi.txt";
const id = "35fcb4c6-5902-40a7-adfe-e9289cab6855";
const reply = (responseId = `chatcmpl-${id}`) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", provider: "harbor-endpoint", model: "dari/routing", responseId },
  });

async function retained(text: string): Promise<string | undefined> {
  const root = await mkdtemp(join(tmpdir(), "dari-manifest-"));
  try {
    await mkdir(join(root, "solver/task/agent"), { recursive: true });
    await writeFile(join(root, path), text);
    // collectOutput can omit the transcript completely once its shared budget is spent.
    const files = new Map<string, string>();
    await retainDariManifest(root, files);
    return files.get(DARI_REQUEST_IDS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("compact IDs survive huge non-accounting lines and UTF-8 chunk boundaries", async () => {
  const delta = JSON.stringify({ type: "message_update", delta: "é".repeat(9 * 1024 * 1024) });
  const manifest = await retained(`Pi notice\n${reply()}\n${delta}\n`);
  expect(JSON.parse(manifest ?? "null")).toEqual({ model: "dari/routing", requestIds: [id] });
});

test("missing, duplicate, foreign, malformed and oversized accounting records remain unpriced", async () => {
  for (const text of [
    `${reply()}\n${reply()}\n`,
    `${reply()}\n${reply("unknown")}\n`,
    `${reply()}\n{broken\n`,
    reply().replace("harbor-endpoint", "foreign"),
    `${reply().slice(0, -1)},"padding":"${"x".repeat(17 * 1024 * 1024)}"}\n`,
  ])
    expect(await retained(text)).toBeUndefined();
});

test("symlink transcripts are not followed", async () => {
  const root = await mkdtemp(join(tmpdir(), "dari-manifest-"));
  try {
    await writeFile(join(root, "outside.txt"), reply());
    await mkdir(join(root, "solver/task/agent"), { recursive: true });
    await symlink(join(root, "outside.txt"), join(root, path));
    const files = new Map([[path, TRUNCATED_OUTPUT]]);
    await retainDariManifest(root, files);
    expect(files.has(DARI_REQUEST_IDS)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

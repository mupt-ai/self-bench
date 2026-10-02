import { gunzipSync, gzipSync } from "node:zlib";
import { extract, pack } from "tar-stream";

/** A `.tar.gz` of `files`, each a path and its contents (a mode after a `|`: "solve.sh|755"). */
export async function gzippedTar(files: Record<string, string>): Promise<Buffer> {
  const packer = pack();
  const chunks: Buffer[] = [];
  packer.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise((resolve) => packer.on("end", resolve));
  for (const [name, text] of Object.entries(files)) {
    const [path = "", mode] = name.split("|");
    await new Promise<void>((resolve, reject) =>
      packer.entry({ name: path, mode: mode ? Number.parseInt(mode, 8) : 0o644 }, text, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  packer.finalize();
  await done;
  return gzipSync(Buffer.concat(chunks));
}

/** The entries of a `.tar.gz`: path, mode, and text. */
export async function tarEntries(
  bytes: Buffer,
): Promise<{ path: string; mode?: number | undefined; text: string }[]> {
  const reader = extract();
  const found: { path: string; mode?: number | undefined; text: string }[] = [];
  const reading = (async () => {
    for await (const entry of reader) {
      const chunks: Buffer[] = [];
      for await (const chunk of entry) chunks.push(chunk as Buffer);
      found.push({
        path: entry.header.name,
        mode: entry.header.mode,
        text: Buffer.concat(chunks).toString(),
      });
    }
  })();
  reader.end(gunzipSync(bytes));
  await reading;
  return found;
}

/** A compiled task bundle for `name`, with a repository snapshot a download leaves out. */
export const taskBundle = (name: string) =>
  gzippedTar({
    "harbor-task/task.toml": `[metadata]\nselfbench_task_id = "${name}"\n`,
    "harbor-task/instruction.md": `Do ${name}.\n`,
    "harbor-task/environment/repo.tar.gz": "the repository",
  });

import { gzipSync } from "node:zlib";
import { type Headers, pack } from "tar-stream";
export async function archive(
  entries: { name: string; text?: string | Buffer; type?: Headers["type"]; linkname?: string }[],
  gzip = true,
): Promise<Buffer> {
  const tar = pack();
  const chunks: Buffer[] = [];
  const done = (async () => {
    for await (const chunk of tar) chunks.push(Buffer.from(chunk));
  })();
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? "");
    tar.entry(
      {
        name: entry.name,
        size: data.length,
        ...(entry.type ? { type: entry.type } : {}),
        ...(entry.linkname ? { linkname: entry.linkname } : {}),
      },
      data,
    );
  }
  tar.finalize();
  await done;
  const bytes = Buffer.concat(chunks);
  return gzip ? gzipSync(bytes) : bytes;
}
export const harborFiles = (root = "alpha/") => [
  {
    name: `${root}task.toml`,
    text: 'version = "1.0"\n[metadata]\ndifficulty = "hard"\ncustom = "preserve me"\n',
  },
  { name: `${root}instruction.md`, text: "Fix the bug" },
  { name: `${root}environment/Dockerfile`, text: "FROM scratch\nRUN touch /NEVER_EXECUTE_UPLOAD" },
  { name: `${root}tests/test.sh`, text: "touch /NEVER_EXECUTE_UPLOAD; exit 99" },
];

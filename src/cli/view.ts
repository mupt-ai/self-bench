import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { projectRoot } from "../project-paths.js";
import { startViewServer } from "../viewer/local-server.js";
import { fail } from "./values.js";

export async function view(args: string[]): Promise<void> {
  const parsed = parseArgs({
    args,
    options: {
      host: { type: "string", default: "127.0.0.1" },
      port: { type: "string", default: "8090" },
    },
    allowPositionals: true,
    strict: true,
  });
  const root = parsed.positionals[0] ?? fail("view requires a directory of Harbor tasks");
  const port = Number(parsed.values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`invalid port: ${parsed.values.port}`);
  }
  const stats = await lstat(resolve(root)).catch(() => undefined);
  if (!stats?.isDirectory()) {
    fail(`not a directory: ${root}`);
  }
  const assets = resolve(projectRoot(import.meta.url), "dist/review/index.html");
  if (!(await lstat(assets).catch(() => undefined))) {
    fail("the viewer is not built; run `bun run build:review` first");
  }
  const server = await startViewServer({ root, host: parsed.values.host, port });
  console.log(`Harbor viewer serving ${resolve(root)} at ${server.url}`);
  await new Promise<void>((resolveWait) => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => {
        void server.stop().finally(resolveWait);
      });
    }
  });
}

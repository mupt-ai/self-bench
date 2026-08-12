import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const output = new URL("../dist/build-metadata.js", import.meta.url);
const configuredCommit = process.env.SELFBENCH_BUILD_COMMIT;

let commit = configuredCommit;
if (!commit) {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    commit = result.stdout.trim();
  } catch {
    commit = "0".repeat(40);
  }
}
if (!/^[0-9a-f]{40}$/i.test(commit)) {
  throw new Error("SELFBENCH_BUILD_COMMIT must be a full commit SHA");
}

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await writeFile(
  output,
  `// Generated during the build.\nexport const buildCommit = ${JSON.stringify(commit.toLowerCase())};\n`,
);

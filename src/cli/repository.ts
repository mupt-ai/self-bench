import { buildCommit } from "../build-metadata.js";
import { runCommand } from "../process.js";
import { projectRoot } from "../project-paths.js";

export async function resolveRepository(path: string): Promise<{ url: string; commit: string }> {
  const [remote, commit] = await Promise.all([
    runCommand("git", ["-C", path, "remote", "get-url", "origin"]),
    runCommand("git", ["-C", path, "rev-parse", "HEAD"]),
  ]);
  return { url: normalizeGitUrl(remote.stdout.trim()), commit: commit.stdout.trim() };
}

function normalizeGitUrl(value: string): string {
  const ssh = /^git@github\.com:(.+)$/.exec(value);
  if (ssh?.[1]) {
    return `https://github.com/${ssh[1]}`;
  }
  if (value.startsWith("https://")) {
    return value;
  }
  throw new Error(`unsupported origin URL: ${value}`);
}

export async function resolveSelfBenchCommit(): Promise<string> {
  if (process.env.SELFBENCH_BUILD_COMMIT) {
    return process.env.SELFBENCH_BUILD_COMMIT;
  }
  if (/^[0-9a-f]{40}$/i.test(buildCommit) && !/^0+$/.test(buildCommit)) {
    return buildCommit;
  }
  const root = projectRoot(import.meta.url);
  try {
    return (await runCommand("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();
  } catch {
    throw new Error(
      "SelfBench was built without commit metadata; set SELFBENCH_BUILD_COMMIT to a full commit SHA",
    );
  }
}

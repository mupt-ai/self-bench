import { createHash } from "node:crypto";
import { chmodSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { step } from "./tui.js";

/** Set by `scripts/build-cli.sh` (`bun build --define`) to package.json's version. */
declare const SELFBENCH_CLI_VERSION: string | undefined;

const REPO = "mupt-ai/self-bench";
const INSTALLER = `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install-cli.sh | sh`;

/** This build's version, or undefined when run from source rather than the released file. */
export function cliVersion(): string | undefined {
  return typeof SELFBENCH_CLI_VERSION === "string" ? SELFBENCH_CLI_VERSION : undefined;
}

/** `1.2.10` > `1.2.9`: compares dot-separated numbers. Negative, zero, or positive. */
export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The newest `cli-v*` release's version. Prod deploys are releases too and fill the newest
 * pages, so this searches several, as the installer does.
 */
export async function latestVersion(fetcher: typeof fetch = fetch): Promise<string> {
  for (let page = 1; page <= 10; page += 1) {
    const response = await fetcher(
      `https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`,
      { headers: { accept: "application/vnd.github+json" } },
    );
    if (!response.ok) throw new Error(`could not list GitHub releases (${response.status})`);
    const releases = (await response.json()) as { tag_name?: string; draft?: boolean }[];
    if (releases.length === 0) break;
    const tag = releases.find((release) => !release.draft && release.tag_name?.startsWith("cli-v"));
    if (tag?.tag_name) return tag.tag_name.slice("cli-v".length);
  }
  throw new Error("no SelfBench CLI release found on GitHub");
}

async function download(url: string, fetcher: typeof fetch): Promise<Buffer> {
  const response = await fetcher(url);
  if (!response.ok) throw new Error(`could not download ${url} (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

/** The installed file this process runs, which `update` replaces. */
function installedFile(): string {
  const script = process.argv[1];
  if (!script)
    throw new Error(`can't find the installed self-bench; reinstall with:\n  ${INSTALLER}`);
  const file = realpathSync(script);
  if (file.split(/[\\/]/).includes("node_modules"))
    throw new Error(
      `this self-bench came from npm. Remove it (npm uninstall -g self-bench) and install with:\n  ${INSTALLER}`,
    );
  if (basename(file) !== "self-bench" || cliVersion() === undefined)
    throw new Error(`update works on the installed CLI only; install it with:\n  ${INSTALLER}`);
  return file;
}

/**
 * `update`: replaces this installed CLI with the newest release, checked against its SHA-256,
 * as the curl installer does. `--check` only reports whether one is newer.
 */
export async function updateCommand(args: string[], fetcher: typeof fetch = fetch): Promise<void> {
  const unknown = args.find((arg) => arg !== "--check");
  if (unknown) throw new Error(`unknown argument: ${unknown}`);
  const current = cliVersion();
  const latest = await latestVersion(fetcher);
  if (current && compareVersions(latest, current) <= 0) {
    step(`self-bench ${current} is up to date`);
    return;
  }
  if (args.includes("--check")) {
    step(`self-bench ${latest} is available${current ? ` (you have ${current})` : ""}`);
    console.log("Run: self-bench update");
    return;
  }
  const file = installedFile();
  const base = `https://github.com/${REPO}/releases/download/cli-v${latest}`;
  const [script, sums] = await Promise.all([
    download(`${base}/self-bench.js`, fetcher),
    download(`${base}/self-bench.js.sha256`, fetcher),
  ]);
  const expected = sums.toString("utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(script).digest("hex");
  if (!expected || expected !== actual)
    throw new Error(`checksum mismatch for cli-v${latest}; nothing was changed`);
  // Write beside the old file and rename over it, so a failure never leaves half a CLI.
  const temp = join(dirname(file), `.self-bench-${process.pid}.tmp`);
  try {
    writeFileSync(temp, script);
    chmodSync(temp, 0o755);
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  step(`Updated self-bench ${current} → ${latest}`);
}

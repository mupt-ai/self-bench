import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import { type TaskDefinition, taskDefinitionSchema } from "./contracts.js";
import { sha256 } from "./hash.js";
import { runCommand } from "./process.js";
import { patchPaths } from "./repair.js";

const HARBOR_SCHEMA_VERSION = "1.4";
const COMPILER_REVISION = 24;

export interface AuthoredTaskFiles {
  readonly definition: TaskDefinition;
  readonly testPatch: string;
  readonly goldPatch: string;
}

export async function loadAuthoredTask(directory: string): Promise<AuthoredTaskFiles> {
  const definition = taskDefinitionSchema.parse(
    JSON.parse(await readFile(join(directory, "definition.json"), "utf8")),
  );
  assertSafeTaskPaths(definition);
  const [testPatch, goldPatch] = await Promise.all([
    readFile(join(directory, "test.patch"), "utf8"),
    readFile(join(directory, "gold.patch"), "utf8"),
  ]);
  if (!testPatch.startsWith("diff --git ")) {
    throw new Error("test.patch is not a Git patch");
  }
  assertSafePatchPaths(testPatch);
  if (!goldPatch.startsWith("diff --git ")) {
    throw new Error("gold.patch is not a Git patch");
  }
  return { definition, testPatch, goldPatch };
}

export async function compileHarborTask(
  authoredDirectory: string,
  repositoryDirectory: string,
  outputDirectory: string,
): Promise<void> {
  const task = await loadAuthoredTask(authoredDirectory);
  const dependencySetupPatch = dependencyManifestPatch(task.goldPatch);
  const preinstallGoldDependencies = dependencySetupPatch.length > 0;
  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "cat-file",
    "-e",
    `${task.definition.baseCommit}^{commit}`,
  ]);
  await rm(outputDirectory, { recursive: true, force: true });
  const environment = join(outputDirectory, "environment");
  const solution = join(outputDirectory, "solution");
  const tests = join(outputDirectory, "tests");
  await Promise.all([
    mkdir(environment, { recursive: true }),
    mkdir(solution, { recursive: true }),
    mkdir(tests, { recursive: true }),
  ]);

  const snapshot = join(outputDirectory, ".repo.tar.gz");
  await runCommand("git", [
    "-C",
    repositoryDirectory,
    "archive",
    "--format=tar.gz",
    `--output=${snapshot}`,
    task.definition.baseCommit,
  ]);
  await Promise.all([
    cp(snapshot, join(environment, "repo.tar.gz")),
    cp(snapshot, join(tests, "repo.tar.gz")),
    writeFile(
      join(outputDirectory, "definition.json"),
      `${JSON.stringify(task.definition, null, 2)}\n`,
    ),
    writeFile(join(outputDirectory, "instruction.md"), `${task.definition.prompt.trim()}\n`),
    writeFile(join(solution, "gold.patch"), task.goldPatch),
    writeFile(join(solution, "solve.sh"), solutionScript()),
    writeFile(join(tests, "test.patch"), task.testPatch),
    writeFile(join(tests, "test.sh"), testScript(task.definition, task.testPatch)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(task.definition)),
    writeFile(
      join(tests, "Dockerfile"),
      verifierDockerfile(task.definition, preinstallGoldDependencies),
    ),
    writeFile(join(outputDirectory, "task.toml"), taskToml(task.definition)),
    ...(preinstallGoldDependencies
      ? [writeFile(join(tests, "dependency-setup.patch"), dependencySetupPatch)]
      : []),
  ]);
  await rm(snapshot);
  await Promise.all([
    chmod(join(solution, "solve.sh"), 0o755),
    chmod(join(tests, "test.sh"), 0o755),
  ]);
  await writeFile(
    join(outputDirectory, ".selfbench-manifest.json"),
    `${JSON.stringify(
      {
        generator: "selfbench",
        harborSchemaVersion: HARBOR_SCHEMA_VERSION,
        compilerRevision: COMPILER_REVISION,
        taskId: task.definition.taskId,
        difficulty: task.definition.difficulty,
        definitionSha256: sha256(JSON.stringify(task.definition)),
        testPatchSha256: sha256(task.testPatch),
        goldPatchSha256: sha256(task.goldPatch),
      },
      null,
      2,
    )}\n`,
  );
}

export async function refreshHarborTask(
  outputDirectory: string,
  definition: TaskDefinition,
): Promise<void> {
  const manifestPath = join(outputDirectory, ".selfbench-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  if (manifest.taskId !== definition.taskId) {
    throw new Error(`bundle task ${String(manifest.taskId)} does not match ${definition.taskId}`);
  }
  const [goldPatch, testPatch] = await Promise.all([
    readFile(join(outputDirectory, "solution/gold.patch"), "utf8"),
    readFile(join(outputDirectory, "tests/test.patch"), "utf8"),
  ]);
  assertSafePatchPaths(testPatch);
  const dependencySetupPatch = dependencyManifestPatch(goldPatch);
  const preinstallGoldDependencies = dependencySetupPatch.length > 0;
  await writeFile(join(outputDirectory, "tests/test.sh"), testScript(definition, testPatch));
  await Promise.all([
    writeFile(join(outputDirectory, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`),
    writeFile(join(outputDirectory, "task.toml"), taskToml(definition)),
    writeFile(join(outputDirectory, "environment/Dockerfile"), agentDockerfile(definition)),
    writeFile(
      join(outputDirectory, "tests/Dockerfile"),
      verifierDockerfile(definition, preinstallGoldDependencies),
    ),
    preinstallGoldDependencies
      ? writeFile(join(outputDirectory, "tests/dependency-setup.patch"), dependencySetupPatch)
      : rm(join(outputDirectory, "tests/dependency-setup.patch"), { force: true }),
    chmod(join(outputDirectory, "tests/test.sh"), 0o755),
  ]);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        compilerRevision: COMPILER_REVISION,
        difficulty: definition.difficulty,
        definitionSha256: sha256(JSON.stringify(definition)),
        testPatchSha256: sha256(testPatch),
        goldPatchSha256: sha256(goldPatch),
      },
      null,
      2,
    )}\n`,
  );
}

function taskToml(task: TaskDefinition): string {
  const metadata = {
    selfbench_task_id: task.taskId,
    difficulty: task.difficulty,
    repo: task.repo,
    base_commit: task.baseCommit,
    workdir: task.workdir,
    source_pr: task.sourcePr,
    compiler_revision: COMPILER_REVISION,
  };
  return `${[
    `schema_version = ${tomlString(HARBOR_SCHEMA_VERSION)}`,
    'artifacts = ["/opt/selfbench/agent.patch"]',
    "",
    "[task]",
    `name = ${tomlString(`selfbench/${task.taskId}`)}`,
    'version = "1.0.0"',
    `description = ${tomlString(`Reproduce ${task.taskId} from its authentic engineer request.`)}`,
    `keywords = ["software-engineering", "private-swe", "selfbench", ${tomlString(task.difficulty)}]`,
    "",
    "[metadata]",
    ...Object.entries(metadata).map(([key, value]) => `${key} = ${tomlValue(value)}`),
    "",
    "[agent]",
    `timeout_sec = ${task.timeouts.agentSeconds}.0`,
    'user = "agent"',
    'network_mode = "allowlist"',
    'allowed_hosts = ["chatgpt.com", "*.chatgpt.com", "openai.com", "*.openai.com"]',
    "",
    "[verifier]",
    `timeout_sec = ${task.timeouts.setupSeconds + task.timeouts.testsSeconds}.0`,
    'user = "root"',
    'environment_mode = "separate"',
    'network_mode = "public"',
    "",
    "[[verifier.collect]]",
    'service = "main"',
    'user = "root"',
    `timeout_sec = ${Math.min(task.timeouts.testsSeconds, 300)}.0`,
    'command = "git --git-dir=/opt/selfbench/base.git --work-tree=/app add -A && git --git-dir=/opt/selfbench/base.git --work-tree=/app diff --cached --binary HEAD > /opt/selfbench/agent.patch"',
    "",
    "[environment]",
    'network_mode = "public"',
    `build_timeout_sec = ${task.timeouts.setupSeconds + 600}.0`,
    `cpus = ${task.resources.cpus}`,
    `memory_mb = ${task.resources.memoryMb}`,
    `storage_mb = ${task.resources.storageMb}`,
    "",
    "[verifier.environment]",
    'network_mode = "public"',
    `build_timeout_sec = ${task.timeouts.setupSeconds + 600}.0`,
    `cpus = ${task.resources.cpus}`,
    `memory_mb = ${task.resources.memoryMb}`,
    `storage_mb = ${task.resources.storageMb}`,
  ].join("\n")}\n`;
}

function agentDockerfile(task: TaskDefinition): string {
  return `${toolchainDockerfile(task.toolchains)}
RUN useradd --create-home --shell /bin/bash agent
${repositoryDockerfile(task)}
RUN git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq \\
    && mkdir -p /opt/selfbench \\
    && cp -a /app/.git /opt/selfbench/base.git \\
    && chown -R agent:agent /app /home/agent /opt/uv-cache \\
    && chown -R root:root /opt/selfbench \\
    && chmod 700 /opt/selfbench \\
    && mkdir -p /home/agent/.cache/uv \\
    && chown -R agent:agent /home/agent/.cache
ENV UV_CACHE_DIR=/home/agent/.cache/uv \\
    UV_NO_BUILD_ISOLATION=1
USER agent
WORKDIR /app
`;
}

function verifierDockerfile(task: TaskDefinition, preinstallGoldDependencies: boolean): string {
  return `${toolchainDockerfile(task.toolchains)}
${repositoryDockerfile(task)}
${preinstallGoldDependencies ? goldDependencySetupLayer(task) : ""}
RUN useradd --create-home --shell /bin/bash verifier \\
    && chown -R verifier:verifier /app /opt/uv-cache \\
    && mkdir -p /opt/selfbench \\
    && chmod 700 /opt/selfbench \\
    && mkdir -p /home/verifier/.cache/uv \\
    && chown -R verifier:verifier /home/verifier/.cache
ENV UV_CACHE_DIR=/home/verifier/.cache/uv \\
    UV_NO_BUILD_ISOLATION=1
COPY test.patch test.sh /tests/
RUN chmod 700 /tests && chmod 600 /tests/test.patch && chmod +x /tests/test.sh
WORKDIR /app
`;
}

function goldDependencySetupLayer(task: TaskDefinition): string {
  return `COPY dependency-setup.patch /tmp/selfbench-dependency-setup.patch
RUN git -C /app apply --binary --whitespace=nowarn /tmp/selfbench-dependency-setup.patch \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && bash -lc ${shellQuote(task.setupCommand)} \\
    && git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq \\
    && rm /tmp/selfbench-dependency-setup.patch
`;
}

export function goldPatchChangesDependencyManifests(patch: string): boolean {
  return dependencyManifestPatch(patch).length > 0;
}

export function dependencyManifestPatch(patch: string): string {
  const sections = patch.split(/(?=^diff --git )/m);
  const selected = sections.filter((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    return match?.[2] ? isDependencyManifest(match[2]) : false;
  });
  return selected.length > 0 ? `${selected.join("").trimEnd()}\n` : "";
}

function isDependencyManifest(path: string): boolean {
  const name = posix.basename(path);
  return (
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/.test(
      name,
    ) ||
    /^(?:pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt)$/.test(
      name,
    ) ||
    /^(?:go\.(?:mod|sum)|Cargo\.(?:toml|lock))$/.test(name)
  );
}

function toolchainDockerfile(toolchains: readonly string[]): string {
  const layers: Record<string, string> = {
    uv: "RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh",
    python:
      "RUN uv python install 3.11 3.12 3.13 && ln -sf /usr/local/bin/python3.12 /usr/local/bin/python3 && ln -sf /usr/local/bin/python3.12 /usr/local/bin/python",
    node: `ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN mkdir -p "$PLAYWRIGHT_BROWSERS_PATH" && chmod 755 "$PLAYWRIGHT_BROWSERS_PATH" \\
    && arch="$(dpkg --print-architecture)" && case "$arch" in arm64) node_arch=arm64 ;; amd64) node_arch=x64 ;; *) exit 1 ;; esac \\
    && curl -fsSL "https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-\${node_arch}.tar.xz" | tar -C /usr/local --strip-components=1 -xJ \\
    && mkdir -p /opt/corepack && chmod 755 /opt/corepack \\
    && corepack enable`,
    bun: "RUN npm install --global bun@1.3.14",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the output is a shell variable.
    go: `RUN arch="$(dpkg --print-architecture)" && curl -fsSL "https://go.dev/dl/go1.25.0.linux-${"${arch}"}.tar.gz" | tar -C /usr/local -xz`,
    rust: "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | env RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo sh -s -- -y --no-modify-path --profile minimal --default-toolchain 1.90.0",
  };
  const selected = new Set(toolchains);
  if (selected.has("python")) {
    selected.add("uv");
  }
  if (selected.has("bun")) {
    selected.add("node");
  }
  const order = ["uv", "python", "node", "bun", "go", "rust"];
  return `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive \\
    UV_LINK_MODE=copy \\
    UV_CACHE_DIR=/opt/uv-cache \\
    UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \\
    UV_PYTHON_BIN_DIR=/usr/local/bin \\
    RUSTUP_HOME=/usr/local/rustup \\
    CARGO_HOME=/usr/local/cargo \\
    COREPACK_HOME=/opt/corepack \\
    PATH=/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
RUN apt-get update && apt-get install -y --no-install-recommends \\
    bash build-essential ca-certificates curl git jq passwd pkg-config procps unzip xz-utils \\
    && rm -rf /var/lib/apt/lists/*
${order
  .filter((name) => selected.has(name))
  .map((name) => layers[name])
  .filter(Boolean)
  .join("\n")}`;
}

function repositoryDockerfile(task: TaskDefinition): string {
  const pythonBuildDependencies = task.toolchains.includes("python")
    ? ` \\
    && find /app -path '*/.venv/bin/python' -exec uv pip install --python '{}' 'setuptools>=70' wheel ';'`
    : "";
  return `COPY repo.tar.gz /tmp/repo.tar.gz
RUN mkdir -p /app && tar -xzf /tmp/repo.tar.gz -C /app && rm /tmp/repo.tar.gz \\
    && git -C /app init -q \\
    && git -C /app config user.email selfbench@local \\
    && git -C /app config user.name selfbench \\
    && git -C /app add -A \\
    && git -C /app commit -qm base
RUN mkdir -p /opt/uv-cache && chmod 777 /opt/uv-cache \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && bash -lc ${shellQuote(task.setupCommand)}${pythonBuildDependencies} \\
    && chmod -R a+rwX /opt/uv-cache`;
}

function solutionScript(): string {
  return `#!/bin/bash
set -euo pipefail
git -C /app apply --binary --whitespace=nowarn /solution/gold.patch
`;
}

function testScript(task: TaskDefinition, testPatch: string): string {
  const repositoryTestPaths = [
    ...new Set([
      ...task.testPaths.map((path) => repositoryRelativePath(task, path)),
      ...patchPaths(testPatch),
    ]),
  ].sort();
  const exclusions = repositoryTestPaths
    .flatMap((path) => [
      `--exclude=${shellQuote(path.replace(/\/$/, ""))}`,
      `--exclude=${shellQuote(`${path.replace(/\/$/, "")}/*`)}`,
    ])
    .join(" ");
  const protectedPaths = repositoryTestPaths.map(shellQuote).join(" ");
  const protectedAbsolute = repositoryTestPaths.map((path) => shellQuote(`/app/${path}`)).join(" ");
  const f2p = taskCommand(task, task.failToPass);
  const p2p = task.passToPass.length > 0 ? taskCommand(task, task.passToPass) : "true";
  return `#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier
patch_applied=1
fail_to_pass=0
pass_to_pass=0
deterministic=0
setup_completed=0
fail_to_pass_exit_code=-1
fail_to_pass_repeat_exit_code=-1
pass_to_pass_exit_code=-1
verifier_cache=""

kill_verifier_processes() { pkill -KILL -u "$(id -u verifier)" 2>/dev/null || true; }
# Some toolchains fetch dependencies at test runtime (e.g. Next.js e2e installs),
# so a single registry connection reset must not be misread as a dead test. Retry
# only infrastructure-style failures with backoff; real assertion failures fail fast.
run_verifier_command() {
  local logfile
  logfile="$(mktemp /tmp/selfbench-verifier-command-XXXXXX.log)"
  local attempt=1
  local status=1
  while [ "$attempt" -le 3 ]; do
    : > "$logfile"
    runuser -u verifier -- env PATH="/usr/local/go/bin:/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin" UV_CACHE_DIR="$verifier_cache" UV_NO_BUILD_ISOLATION=1 bash -lc "$1" >"$logfile" 2>&1
    status=$?
    if [ "$status" -eq 0 ]; then
      break
    fi
    if [ "$attempt" -lt 3 ] && grep -qE 'ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|ENOTFOUND|EAI_AGAIN|META_FETCH_FAIL|FetchError|EPIPE|EPERM|registry\\.npmjs' "$logfile"; then
      sleep "$((10 * attempt))"
      attempt=$((attempt + 1))
      continue
    fi
    break
  done
  cat "$logfile"
  rm -f "$logfile"
  kill_verifier_processes
  return "$status"
}
protect_held_out_path() {
  local path="$1"
  chown -R root:root -- "$path"
  chmod -R a-w,go+rX -- "$path"
}

if [ ! -f /opt/selfbench/agent.patch ]; then
  patch_applied=0
elif [ -s /opt/selfbench/agent.patch ]; then
  git -C /app apply --binary --whitespace=nowarn ${exclusions} /opt/selfbench/agent.patch || patch_applied=0
fi

if [ "$patch_applied" -eq 1 ]; then setup_completed=1; fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  kill_verifier_processes
  for protected_path in ${protectedPaths}; do
    git -C /app restore --source=HEAD --staged --worktree -- "$protected_path" 2>/dev/null || true
    git -C /app clean -fd -- "$protected_path" >/dev/null 2>&1 || true
  done
  git -C /app apply --binary --whitespace=nowarn /tests/test.patch || patch_applied=0
  if [ "$patch_applied" -eq 1 ]; then
    for protected_path in ${protectedAbsolute}; do protect_held_out_path "$protected_path"; done
  fi
  rm -f /tests/test.patch
fi

if [ "$patch_applied" -eq 1 ] && [ "$setup_completed" -eq 1 ]; then
  cd ${shellQuote(`/app/${task.workdir}`)}
  verifier_cache="$(mktemp -d /tmp/selfbench-verifier-uv-XXXXXX)"
  cp -a /opt/uv-cache/. "$verifier_cache"/
  chown -R verifier:verifier "$verifier_cache"
  if run_verifier_command ${shellQuote(f2p)}; then
    fail_to_pass_exit_code=0
    fail_to_pass=1
    if run_verifier_command ${shellQuote(f2p)}; then
      fail_to_pass_repeat_exit_code=0
      deterministic=1
    else
      fail_to_pass_repeat_exit_code=$?
    fi
  else
    fail_to_pass_exit_code=$?
  fi
  if run_verifier_command ${shellQuote(p2p)}; then
    pass_to_pass_exit_code=0
    pass_to_pass=1
  else
    pass_to_pass_exit_code=$?
  fi
  rm -rf "$verifier_cache"
fi

reward=0
if [ "$patch_applied" -eq 1 ] && [ "$fail_to_pass" -eq 1 ] && [ "$pass_to_pass" -eq 1 ] && [ "$deterministic" -eq 1 ]; then reward=1; fi
cat > /logs/verifier/reward.json <<EOF
{"reward": $reward, "patch_applied": $patch_applied, "fail_to_pass": $fail_to_pass, "pass_to_pass": $pass_to_pass, "deterministic": $deterministic, "setup_completed": $setup_completed, "fail_to_pass_exit_code": $fail_to_pass_exit_code, "fail_to_pass_repeat_exit_code": $fail_to_pass_repeat_exit_code, "pass_to_pass_exit_code": $pass_to_pass_exit_code}
EOF
exit 0
`;
}

function taskCommand(task: TaskDefinition, tests: readonly string[]): string {
  return task.testCommand.replaceAll("{tests}", tests.map(shellQuote).join(" "));
}

function assertSafeTaskPaths(task: TaskDefinition): void {
  for (const path of [
    task.workdir,
    ...task.testPaths.map((value) => posix.join(task.workdir, value)),
  ]) {
    const resolved = resolve("/repo", path);
    if (resolved !== "/repo" && !resolved.startsWith(`/repo${sep}`)) {
      throw new Error(`task path escapes repository: ${path}`);
    }
  }
}

function assertSafePatchPaths(patch: string): void {
  const paths = patchPaths(patch);
  if (paths.length === 0) {
    throw new Error("test.patch changes no files");
  }
  for (const path of paths) {
    const resolved = resolve("/repo", path);
    if (
      resolved === "/repo" ||
      !resolved.startsWith(`/repo${sep}`) ||
      resolved.startsWith(`/repo${sep}.git${sep}`) ||
      resolved === `/repo${sep}.git`
    ) {
      throw new Error(`test patch path escapes repository: ${path}`);
    }
  }
}

function repositoryRelativePath(task: TaskDefinition, path: string): string {
  return posix.normalize(posix.join(task.workdir, path)).replace(/^\.\//, "");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(value: string | number): string {
  return typeof value === "string" ? tomlString(value) : String(value);
}

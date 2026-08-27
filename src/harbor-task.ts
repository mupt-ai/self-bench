import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve, sep } from "node:path";
import { type TaskDefinition, taskDefinitionSchema } from "./contracts.js";
import { assertEnvironmentEvidence, assertEnvironmentPolicy } from "./environment.js";
import { sha256 } from "./hash.js";
import { runCommand } from "./process.js";
import { patchPaths } from "./repair.js";

const HARBOR_SCHEMA_VERSION = "1.4";
const COMPILER_REVISION = 26;

export interface AuthoredTaskFiles {
  readonly definition: TaskDefinition;
  readonly testPatch: string;
  readonly goldPatch: string;
}

export async function loadAuthoredTask(directory: string): Promise<AuthoredTaskFiles> {
  const definition = taskDefinitionSchema.parse(
    JSON.parse(await readFile(join(directory, "definition.json"), "utf8")),
  );
  assertEnvironmentPolicy(definition.environment);
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
  const repositoryFiles = await runCommand("git", [
    "-C",
    repositoryDirectory,
    "ls-tree",
    "-r",
    "--name-only",
    task.definition.baseCommit,
  ]);
  assertEnvironmentEvidence(
    task.definition.environment,
    new Set(repositoryFiles.stdout.split("\n").filter(Boolean)),
  );
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
    writeFile(join(tests, "task-test.sh"), testScript(task.definition, task.testPatch)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(task.definition)),
    writeFile(
      join(tests, "Dockerfile"),
      verifierDockerfile(task.definition, preinstallGoldDependencies),
    ),
    ...environmentContextFiles(environment, task.definition),
    ...environmentContextFiles(tests, task.definition),
    ...serviceComposeFiles(tests, task.definition),
    writeFile(join(outputDirectory, "task.toml"), taskToml(task.definition)),
    ...(preinstallGoldDependencies
      ? [writeFile(join(tests, "dependency-setup.patch"), dependencySetupPatch)]
      : []),
  ]);
  await rm(snapshot);
  await Promise.all([
    chmod(join(solution, "solve.sh"), 0o755),
    chmod(join(tests, "test.sh"), 0o755),
    chmod(join(tests, "task-test.sh"), 0o755),
    chmod(join(environment, "root-setup.sh"), 0o755),
    chmod(join(environment, "setup.sh"), 0o755),
    chmod(join(environment, "smoke.sh"), 0o755),
    chmod(join(tests, "root-setup.sh"), 0o755),
    chmod(join(tests, "setup.sh"), 0o755),
    chmod(join(tests, "smoke.sh"), 0o755),
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
        environmentSha256: sha256(JSON.stringify(task.definition.environment)),
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
  assertEnvironmentPolicy(definition.environment);
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
  const verifierScript = testScript(definition, testPatch);
  await Promise.all([
    writeFile(join(outputDirectory, "tests/test.sh"), verifierScript),
    writeFile(join(outputDirectory, "tests/task-test.sh"), verifierScript),
  ]);
  const environment = join(outputDirectory, "environment");
  const tests = join(outputDirectory, "tests");
  await Promise.all([
    writeFile(join(outputDirectory, "definition.json"), `${JSON.stringify(definition, null, 2)}\n`),
    writeFile(join(outputDirectory, "task.toml"), taskToml(definition)),
    writeFile(join(environment, "Dockerfile"), agentDockerfile(definition)),
    writeFile(
      join(tests, "Dockerfile"),
      verifierDockerfile(definition, preinstallGoldDependencies),
    ),
    ...environmentContextFiles(environment, definition),
    ...environmentContextFiles(tests, definition),
    rm(join(environment, "docker-compose.yaml"), { force: true }),
    ...serviceComposeFiles(tests, definition),
    preinstallGoldDependencies
      ? writeFile(join(tests, "dependency-setup.patch"), dependencySetupPatch)
      : rm(join(tests, "dependency-setup.patch"), { force: true }),
    chmod(join(tests, "test.sh"), 0o755),
    chmod(join(tests, "task-test.sh"), 0o755),
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
        environmentSha256: sha256(JSON.stringify(definition.environment)),
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
  return `${baseDockerfile(task)}
RUN useradd --create-home --shell /bin/bash agent \\
    && git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq \\
    && mkdir -p /opt/selfbench \\
    && cp -a /app/.git /opt/selfbench/base.git \\
    && chown -R agent:agent /app /home/agent \\
    && chown -R root:root /opt/selfbench \\
    && chmod 700 /opt/selfbench
ENV HOME=/home/agent
USER agent
WORKDIR /app
`;
}

function verifierDockerfile(task: TaskDefinition, preinstallGoldDependencies: boolean): string {
  return `${baseDockerfile(task)}
${preinstallGoldDependencies ? goldDependencySetupLayer(task) : ""}
RUN useradd --create-home --shell /bin/bash verifier \\
    && chown -R verifier:verifier /app /home/verifier \\
    && mkdir -p /opt/selfbench \\
    && chmod 700 /opt/selfbench
ENV HOME=/home/verifier
COPY test.patch test.sh task-test.sh /tests/
RUN chmod 700 /tests && chmod 600 /tests/test.patch && chmod +x /tests/test.sh /tests/task-test.sh
WORKDIR /app
`;
}

function baseDockerfile(task: TaskDefinition): string {
  const environmentVariables = Object.entries(task.environment.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `ENV ${name}=${JSON.stringify(value)}`)
    .join("\n");
  return `FROM ${task.environment.baseImage}
USER root
ENTRYPOINT []
COPY root-setup.sh /tmp/selfbench-root-setup.sh
RUN /bin/sh /tmp/selfbench-root-setup.sh \\
    && command -v bash >/dev/null \\
    && command -v git >/dev/null \\
    && command -v pkill >/dev/null \\
    && command -v runuser >/dev/null \\
    && command -v tar >/dev/null \\
    && command -v useradd >/dev/null \\
    && rm /tmp/selfbench-root-setup.sh
${environmentVariables}
COPY setup.sh smoke.sh /opt/selfbench-environment/
COPY repo.tar.gz /tmp/repo.tar.gz
RUN mkdir -p /app \\
    && tar -xzf /tmp/repo.tar.gz -C /app \\
    && rm /tmp/repo.tar.gz \\
    && git -C /app init -q \\
    && git -C /app config user.email selfbench@local \\
    && git -C /app config user.name selfbench \\
    && git -C /app add -A \\
    && git -C /app commit -qm base \\
    && chmod 755 /opt/selfbench-environment/setup.sh /opt/selfbench-environment/smoke.sh \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && /opt/selfbench-environment/setup.sh`;
}

function goldDependencySetupLayer(task: TaskDefinition): string {
  return `COPY dependency-setup.patch /tmp/selfbench-dependency-setup.patch
RUN git -C /app apply --binary --whitespace=nowarn /tmp/selfbench-dependency-setup.patch \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && /opt/selfbench-environment/setup.sh \\
    && git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq \\
    && rm /tmp/selfbench-dependency-setup.patch
`;
}

function environmentContextFiles(directory: string, task: TaskDefinition): Promise<void>[] {
  return [
    writeFile(
      join(directory, "root-setup.sh"),
      posixShellScript(task.environment.rootSetupCommand),
    ),
    writeFile(join(directory, "setup.sh"), bashScript(task.environment.setupCommand)),
    writeFile(join(directory, "smoke.sh"), smokeScript(task)),
  ];
}

function serviceComposeFiles(directory: string, task: TaskDefinition): Promise<void>[] {
  const path = join(directory, "docker-compose.yaml");
  if (task.environment.services.length === 0) {
    return [rm(path, { force: true })];
  }
  const dependsOn = Object.fromEntries(
    task.environment.services.map((service) => [service.name, { condition: "service_healthy" }]),
  );
  const services = Object.fromEntries(
    task.environment.services.map((service) => [
      service.name,
      {
        image: service.image,
        environment: service.environmentVariables,
        ...(service.command ? { command: service.command.map(escapeComposeInterpolation) } : {}),
        healthcheck: {
          test: service.healthcheck.test.map(escapeComposeInterpolation),
          interval: `${service.healthcheck.intervalSeconds}s`,
          timeout: `${service.healthcheck.timeoutSeconds}s`,
          retries: service.healthcheck.retries,
          start_period: `${service.healthcheck.startPeriodSeconds}s`,
        },
      },
    ]),
  );
  return [
    writeFile(
      path,
      `${JSON.stringify({ services: { main: { build: ".", depends_on: dependsOn }, ...services } }, null, 2)}\n`,
    ),
  ];
}

function escapeComposeInterpolation(value: string): string {
  return value.replaceAll("$", "$$");
}

function posixShellScript(command: string): string {
  return `#!/bin/sh\nset -eu\n${command.trim()}\n`;
}

function bashScript(command: string): string {
  return `#!/usr/bin/env bash\nset -euo pipefail\n${command.trim()}\n`;
}

function smokeScript(task: TaskDefinition): string {
  return `#!/usr/bin/env bash\nset -euo pipefail\ncd ${shellQuote(`/app/${task.workdir}`)}\n${task.environment.smokeCommand.trim()}\n`;
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
kill_verifier_processes() { pkill -KILL -u "$(id -u verifier)" 2>/dev/null || true; }
# Some test runners fetch dependencies at runtime, so a single registry connection
# reset must not be misread as a dead test. Retry
# only infrastructure-style failures with backoff; real assertion failures fail fast.
run_verifier_command() {
  local logfile
  logfile="$(mktemp /tmp/selfbench-verifier-command-XXXXXX.log)"
  local attempt=1
  local status=1
  while [ "$attempt" -le 3 ]; do
    : > "$logfile"
    runuser -u verifier --preserve-environment -- bash -c "$1" >"$logfile" 2>&1
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

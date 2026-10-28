import type { Difficulty } from "../../contracts/index.js";
import { COMPILER_REVISION, HARBOR_SCHEMA_VERSION } from "./constants.js";

/** A compiled task besides its files: its candidate's identity, and its tier (audit.ts). */
export interface TaskIdentity {
  readonly taskId: string;
  readonly difficulty: Difficulty;
  readonly repo: string;
  readonly baseCommit: string;
  readonly sourcePr: number;
}

/** Every task's limits; an author fits its Dockerfile and tests to them. */
export const TASK_LIMITS = {
  buildSeconds: 1500,
  testsSeconds: 1800,
  cpus: 4,
  memoryMb: 8192,
  storageMb: 20480,
} as const;

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(value: string | number): string {
  return typeof value === "string" ? tomlString(value) : String(value);
}

export function taskToml(task: TaskIdentity): string {
  const metadata = {
    selfbench_task_id: task.taskId,
    difficulty: task.difficulty,
    repo: task.repo,
    base_commit: task.baseCommit,
    source_pr: task.sourcePr,
    compiler_revision: COMPILER_REVISION,
  };
  const limits = [
    `build_timeout_sec = ${TASK_LIMITS.buildSeconds}.0`,
    `cpus = ${TASK_LIMITS.cpus}`,
    `memory_mb = ${TASK_LIMITS.memoryMb}`,
    `storage_mb = ${TASK_LIMITS.storageMb}`,
  ];
  return `${[
    `schema_version = ${tomlString(HARBOR_SCHEMA_VERSION)}`,
    'artifacts = ["/opt/selfbench/agent.patch", "/opt/selfbench/agent-base"]',
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
    // Each run gives the agent its time (prepareHarborRun), so the task sets none.
    "[agent]",
    'user = "root"',
    'network_mode = "allowlist"',
    // The evaluation supplies its selected provider hosts through --allow-agent-host.
    "allowed_hosts = []",
    "",
    "[verifier]",
    `timeout_sec = ${TASK_LIMITS.testsSeconds}.0`,
    'user = "root"',
    'environment_mode = "separate"',
    'network_mode = "public"',
    "",
    "[[verifier.collect]]",
    'service = "main"',
    'user = "root"',
    "timeout_sec = 300.0",
    `command = ${tomlString(COLLECT_AGENT_PATCH)}`,
    "",
    "[environment]",
    'network_mode = "public"',
    ...limits,
    "",
    "[verifier.environment]",
    'network_mode = "public"',
    ...limits,
  ].join("\n")}\n`;
}
// The agent runs as root, so it can reach base.git. The hook records the baseline's history as
// tree ids (post-setup, then snapshot); the verifier checks it against its own untouched HEAD.
const BASE_GIT = "git --git-dir=/opt/selfbench/base.git --work-tree=/app";
const COLLECT_AGENT_PATCH = [
  `${BASE_GIT} log --format=%T HEAD > /opt/selfbench/agent-base`,
  `${BASE_GIT} add -A`,
  `${BASE_GIT} diff --cached --binary HEAD > /opt/selfbench/agent.patch`,
].join(" && ");

export function agentDockerfile(authored: string): string {
  // The post-setup tree is committed as the baseline for agent.patch, so files that the author's
  // setup creates and does not gitignore never land in the agent's diff and never collide with
  // the verifier image, built from the same Dockerfile. The agent runs as root with the HOME and
  // caches the Dockerfile left. Only this image runs smoke.sh, in the agent phase.
  return `${baseDockerfile(authored)}
COPY smoke.sh /opt/selfbench-environment/
RUN chmod 755 /opt/selfbench-environment/smoke.sh \\
    && git -C /app add -A \\
    && git -C /app -c core.hooksPath=/dev/null commit -qm selfbench-setup --allow-empty --no-verify \\
    && mkdir -p /opt/selfbench \\
    && cp -a /app/.git /opt/selfbench/base.git
WORKDIR /app
`;
}

export function verifierDockerfile(authored: string): string {
  return `${baseDockerfile(authored)}
RUN useradd --create-home --shell /bin/bash verifier \\
    && chown -R verifier:verifier /app /home/verifier \\
    && mkdir -p /opt/selfbench \\
    && chmod 700 /opt/selfbench
ENV HOME=/home/verifier
COPY runtime/ run-tests.sh /opt/selfbench-runtime/
RUN chown -R root:root /opt/selfbench-runtime && chmod 755 /opt/selfbench-runtime && chmod 644 /opt/selfbench-runtime/*
COPY test.patch test.sh /tests/
RUN chmod 700 /tests && chmod 600 /tests/test.patch && chmod +x /tests/test.sh
WORKDIR /app
`;
}

/**
 * The author's Dockerfile, then the snapshot it unpacked into /app committed as the base, which
 * the setup it ran leaves as uncommitted changes. Both images share this.
 */
function baseDockerfile(authored: string): string {
  const fail = (problem: string) => `{ echo ${JSON.stringify(problem)} >&2; exit 1; }`;
  return `${authored.trimEnd()}
USER root
ENTRYPOINT []
COPY repo.tar.gz /tmp/selfbench-repo.tar.gz
RUN for tool in bash git pkill runuser tar useradd; do \\
      command -v "$tool" >/dev/null || ${fail("SelfBench needs $tool in the image")}; \\
    done \\
    && if [ -e /app/.git ]; then ${fail("/app/.git must not exist: SelfBench versions /app itself")}; fi \\
    && mkdir /tmp/selfbench-repo \\
    && tar -xzf /tmp/selfbench-repo.tar.gz -C /tmp/selfbench-repo \\
    && git -C /app init -q \\
    && git -C /app config user.email selfbench@local \\
    && git -C /app config user.name selfbench \\
    && git -C /app --work-tree=/tmp/selfbench-repo add -A \\
    && git -C /app -c core.hooksPath=/dev/null commit -qm base --no-verify \\
    && if [ -n "$(git -C /app ls-files --deleted)" ]; then ${fail("/app lacks files of repo.tar.gz: unpack it with ADD repo.tar.gz /app/")}; fi \\
    && rm -rf /tmp/selfbench-repo /tmp/selfbench-repo.tar.gz`;
}

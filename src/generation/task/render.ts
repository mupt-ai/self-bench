import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../../contracts/index.js";
import { patchPaths } from "../../lib/patch-paths.js";
import { shellQuote } from "../../lib/util.js";
import { COMPILER_REVISION, HARBOR_SCHEMA_VERSION } from "./constants.js";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlValue(value: string | number): string {
  return typeof value === "string" ? tomlString(value) : String(value);
}

export function taskToml(task: TaskDefinition): string {
  const metadata = {
    selfbench_task_id: task.taskId,
    difficulty: task.difficulty,
    repo: task.repo,
    base_commit: task.baseCommit,
    workdir: task.workdir,
    source_pr: task.sourcePr,
    compiler_revision: COMPILER_REVISION,
    test_selection: task.testSelection?.mode ?? "unspecified",
  };
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
    `command = ${tomlString(COLLECT_AGENT_PATCH)}`,
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
// The agent runs as root, so it can reach base.git. The hook records the baseline's history as
// tree ids (post-setup, then snapshot); the verifier checks it against its own untouched HEAD.
const BASE_GIT = "git --git-dir=/opt/selfbench/base.git --work-tree=/app";
const COLLECT_AGENT_PATCH = [
  `${BASE_GIT} log --format=%T HEAD > /opt/selfbench/agent-base`,
  `${BASE_GIT} add -A`,
  `${BASE_GIT} diff --cached --binary HEAD > /opt/selfbench/agent.patch`,
].join(" && ");

export function agentDockerfile(task: TaskDefinition): string {
  // The post-setup tree is committed as the baseline for agent.patch, so files that setup.sh
  // creates and does not gitignore never land in the agent's diff and never collide with the
  // verifier image, which ran the same setup. The agent runs as root with setup's HOME and
  // caches, exactly as setup left them. Only this image runs smoke.sh, in the agent phase.
  return `${baseDockerfile(task)}
COPY smoke.sh /opt/selfbench-environment/
RUN chmod 755 /opt/selfbench-environment/smoke.sh \\
    && git -C /app add -A \\
    && git -C /app -c core.hooksPath=/dev/null -c user.email=selfbench@local -c user.name=selfbench commit -qm selfbench-setup --allow-empty --no-verify \\
    && mkdir -p /opt/selfbench \\
    && cp -a /app/.git /opt/selfbench/base.git
WORKDIR /app
`;
}
export function verifierDockerfile(task: TaskDefinition, dependencySetupPatch: string): string {
  return `${baseDockerfile(task)}
${dependencySetupPatch.length > 0 ? goldDependencySetupLayer(task, dependencySetupPatch) : ""}
RUN useradd --create-home --shell /bin/bash verifier \\
    && chown -R verifier:verifier /app /home/verifier \\
    && mkdir -p /opt/selfbench \\
    && chmod 700 /opt/selfbench
ENV HOME=/home/verifier
COPY runtime/ /opt/selfbench-runtime/
RUN chown -R root:root /opt/selfbench-runtime && chmod 755 /opt/selfbench-runtime && chmod 644 /opt/selfbench-runtime/*
COPY test.patch test.sh /tests/
RUN chmod 700 /tests && chmod 600 /tests/test.patch && chmod +x /tests/test.sh
WORKDIR /app
`;
}
/**
 * Where image builds stage the files they copy in and remove. E2B starts each template build step
 * in a freshly booted sandbox, which empties /tmp, so a file copied there is often gone by the
 * step that reads it.
 */
export const BUILD_INPUTS = "/opt/selfbench-build";

function baseDockerfile(task: TaskDefinition): string {
  const environmentVariables = Object.entries(task.environment.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `ENV ${name}=${JSON.stringify(value)}`)
    .join("\n");
  return `FROM ${task.environment.baseImage}
USER root
ENTRYPOINT []
COPY root-setup.sh ${BUILD_INPUTS}/root-setup.sh
RUN /bin/sh ${BUILD_INPUTS}/root-setup.sh \\
    && command -v bash >/dev/null \\
    && command -v git >/dev/null \\
    && command -v pkill >/dev/null \\
    && command -v runuser >/dev/null \\
    && command -v tar >/dev/null \\
    && command -v useradd >/dev/null \\
    && rm ${BUILD_INPUTS}/root-setup.sh
${environmentVariables}
COPY setup.sh /opt/selfbench-environment/
COPY repo.tar.gz ${BUILD_INPUTS}/repo.tar.gz
RUN mkdir -p /app \\
    && tar -xzf ${BUILD_INPUTS}/repo.tar.gz -C /app \\
    && rm ${BUILD_INPUTS}/repo.tar.gz \\
    && git -C /app init -q \\
    && git -C /app config user.email selfbench@local \\
    && git -C /app config user.name selfbench \\
    && git -C /app add -A \\
    && git -C /app -c core.hooksPath=/dev/null commit -qm base --no-verify \\
    && chmod 755 /opt/selfbench-environment/setup.sh \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && /opt/selfbench-environment/setup.sh`;
}
function goldDependencySetupLayer(task: TaskDefinition, dependencySetupPatch: string): string {
  // Only the manifest paths the gold patch touched are reset to the base snapshot; setup outputs
  // that are not gitignored must survive, exactly as they do in the agent image.
  const manifestPaths = patchPaths(dependencySetupPatch).map(shellQuote).join(" ");
  return `COPY dependency-setup.patch ${BUILD_INPUTS}/dependency-setup.patch
RUN git -C /app apply --binary --whitespace=nowarn ${BUILD_INPUTS}/dependency-setup.patch \\
    && cd ${shellQuote(`/app/${task.workdir}`)} \\
    && /opt/selfbench-environment/setup.sh \\
    && git -C /app reset --hard -q HEAD \\
    && git -C /app clean -fdq -- ${manifestPaths} \\
    && rm ${BUILD_INPUTS}/dependency-setup.patch
`;
}
export function environmentContextFiles(directory: string, task: TaskDefinition): Promise<void>[] {
  return [
    writeFile(
      join(directory, "root-setup.sh"),
      posixShellScript(task.environment.rootSetupCommand),
    ),
    writeFile(join(directory, "setup.sh"), bashScript(task.environment.setupCommand)),
  ];
}
export function serviceComposeFiles(directory: string, task: TaskDefinition): Promise<void>[] {
  const path = join(directory, "docker-compose.yaml");
  if (task.environment.services.length === 0) {
    return [rm(path, { force: true })];
  }
  return [writeFile(path, serviceComposeYaml(task))];
}
export function serviceComposeYaml(task: TaskDefinition): string {
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
  return `${JSON.stringify({ services: { main: { build: ".", depends_on: dependsOn }, ...services } }, null, 2)}\n`;
}
function escapeComposeInterpolation(value: string): string {
  return value.replaceAll("$", "$$");
}
export function posixShellScript(command: string): string {
  return `#!/bin/sh\nset -eu\n${command.trim()}\n`;
}
export function bashScript(command: string): string {
  return `#!/usr/bin/env bash\nset -euo pipefail\n${command.trim()}\n`;
}
export function smokeScript(task: TaskDefinition): string {
  return `#!/usr/bin/env bash\nset -euo pipefail\ncd ${shellQuote(`/app/${task.workdir}`)}\n${task.environment.smokeCommand.trim()}\n`;
}

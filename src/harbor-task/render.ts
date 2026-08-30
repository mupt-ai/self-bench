import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskDefinition } from "../contracts.js";
import { COMPILER_REVISION, HARBOR_SCHEMA_VERSION } from "./constants.js";
import { shellQuote } from "./paths.js";

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
export function agentDockerfile(task: TaskDefinition): string {
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
export function verifierDockerfile(
  task: TaskDefinition,
  preinstallGoldDependencies: boolean,
): string {
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
export function environmentContextFiles(directory: string, task: TaskDefinition): Promise<void>[] {
  return [
    writeFile(
      join(directory, "root-setup.sh"),
      posixShellScript(task.environment.rootSetupCommand),
    ),
    writeFile(join(directory, "setup.sh"), bashScript(task.environment.setupCommand)),
    writeFile(join(directory, "smoke.sh"), smokeScript(task)),
  ];
}
export function serviceComposeFiles(directory: string, task: TaskDefinition): Promise<void>[] {
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

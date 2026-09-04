import type { TaskFileEntry, TaskFiles } from "../types";
import { type DockerInstruction, parseDockerfile } from "./dockerfile";
import { parseToml, type TomlSection } from "./toml";

export interface ScriptFile {
  label: string;
  path: string;
  text: string;
}

export interface DockerImage {
  label: string;
  path: string;
  text: string;
  instructions: DockerInstruction[];
}

export interface ServiceLike {
  name?: string;
  image?: string;
  command?: string[];
  environmentVariables?: Record<string, string>;
  healthcheck?: {
    test?: string[];
    intervalSeconds?: number;
    timeoutSeconds?: number;
    retries?: number;
    startPeriodSeconds?: number;
  };
}

export interface DefinitionLike {
  taskId?: string;
  difficulty?: string;
  repo?: string;
  baseCommit?: string;
  workdir?: string;
  testCommand?: string;
  failToPass?: string[];
  passToPass?: string[];
  testPaths?: string[];
  sourcePr?: number;
  sourceUrl?: string;
  prompt?: string;
  timeouts?: { setupSeconds?: number; agentSeconds?: number; testsSeconds?: number };
  resources?: { cpus?: number; memoryMb?: number; storageMb?: number };
  environment?: {
    baseImage?: string;
    rootSetupCommand?: string;
    setupCommand?: string;
    smokeCommand?: string;
    environmentVariables?: Record<string, string>;
    services?: ServiceLike[];
    source?: string;
    evidence?: { path?: string; reason?: string }[];
  };
}

export interface TaskModel {
  taskId: string;
  files: TaskFileEntry[];
  byPath: Map<string, TaskFileEntry>;
  definition?: DefinitionLike;
  toml: TomlSection[];
  instruction?: string;
  goldPatch?: string;
  testPatch?: string;
  dependencyPatch?: string;
  images: DockerImage[];
  scripts: ScriptFile[];
  compose?: string;
}

const SCRIPT_LABELS: [string, string][] = [
  ["environment/root-setup.sh", "root setup (agent image)"],
  ["environment/setup.sh", "setup (agent image)"],
  ["environment/smoke.sh", "smoke (agent image)"],
  ["tests/root-setup.sh", "root setup (verifier image)"],
  ["tests/setup.sh", "setup (verifier image)"],
  ["tests/smoke.sh", "smoke (verifier image)"],
  ["tests/test.sh", "verifier test.sh"],
  ["tests/task-test.sh", "verifier task-test.sh"],
  ["solution/solve.sh", "oracle solve.sh"],
];

export function buildTaskModel(files: TaskFiles): TaskModel {
  const byPath = new Map(files.files.map((file) => [file.path, file]));
  const text = (path: string): string | undefined => byPath.get(path)?.text;
  const definition = parseJson(text("definition.json"));
  const tomlText = text("task.toml");
  const images: DockerImage[] = [];
  for (const file of files.files) {
    const name = file.path.split("/").pop() ?? "";
    if (!/^Dockerfile(\..+)?$/.test(name) || file.text === undefined) continue;
    const label =
      file.path === "environment/Dockerfile"
        ? "agent image"
        : file.path === "tests/Dockerfile"
          ? "verifier image"
          : file.path;
    images.push({
      label,
      path: file.path,
      text: file.text,
      instructions: parseDockerfile(file.text),
    });
  }
  const scripts: ScriptFile[] = [];
  for (const [path, label] of SCRIPT_LABELS) {
    const body = text(path);
    if (body !== undefined) scripts.push({ label, path, text: body });
  }
  const instruction = text("instruction.md") ?? definition?.prompt;
  const goldPatch = text("solution/gold.patch") ?? text("gold.patch");
  const testPatch = text("tests/test.patch") ?? text("test.patch");
  const dependencyPatch = text("tests/dependency-setup.patch");
  const compose = text("tests/docker-compose.yaml") ?? text("environment/docker-compose.yaml");
  return {
    taskId: files.taskId,
    files: files.files,
    byPath,
    ...(definition ? { definition } : {}),
    toml: tomlText ? parseToml(tomlText) : [],
    ...(instruction !== undefined ? { instruction } : {}),
    ...(goldPatch !== undefined ? { goldPatch } : {}),
    ...(testPatch !== undefined ? { testPatch } : {}),
    ...(dependencyPatch !== undefined ? { dependencyPatch } : {}),
    images,
    scripts,
    ...(compose !== undefined ? { compose } : {}),
  };
}

export function parseJson(text: string | undefined): DefinitionLike | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null ? (value as DefinitionLike) : undefined;
  } catch {
    return undefined;
  }
}

export function fileKind(
  path: string,
): "patch" | "json" | "toml" | "dockerfile" | "shell" | "text" {
  const name = path.split("/").pop() ?? path;
  if (name.endsWith(".patch") || name.endsWith(".diff")) return "patch";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".toml")) return "toml";
  if (/^Dockerfile/.test(name)) return "dockerfile";
  if (name.endsWith(".sh")) return "shell";
  return "text";
}

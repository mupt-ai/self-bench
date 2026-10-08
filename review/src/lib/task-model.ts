import type { TaskFileEntry, TaskFiles } from "../types";
import { type DockerInstruction, parseDockerfile } from "./dockerfile";
import { parseToml, type TomlSection } from "./toml";

interface DockerImage {
  label: string;
  path: string;
  text: string;
  instructions: DockerInstruction[];
}

interface ServiceLike {
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

interface DefinitionLike {
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
  timeouts?: { setupSeconds?: number; testsSeconds?: number };
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
  compose?: string;
  /** Path of the file `compose` was read from, so Open Raw shows the same copy. */
  composePath?: string;
}

const COMPOSE_PATHS = ["tests/docker-compose.yaml", "environment/docker-compose.yaml"];

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
        ? "Agent Image"
        : file.path === "tests/Dockerfile"
          ? "Verifier Image"
          : file.path;
    images.push({
      label,
      path: file.path,
      text: file.text,
      instructions: parseDockerfile(file.text),
    });
  }
  const instruction = text("instruction.md") ?? definition?.prompt;
  const goldPatch = text("solution/gold.patch") ?? text("gold.patch");
  const testPatch = text("tests/test.patch") ?? text("test.patch");
  const dependencyPatch = text("tests/dependency-setup.patch");
  const composePath = COMPOSE_PATHS.find((path) => text(path) !== undefined);
  const compose = composePath ? text(composePath) : undefined;
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
    ...(compose !== undefined && composePath ? { compose, composePath } : {}),
  };
}

function parseJson(text: string | undefined): DefinitionLike | undefined {
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

/** The file a task opens on: its instruction, else its config, else its first readable file. */
export function firstFile<File extends TaskFileEntry>(files: readonly File[]): File | undefined {
  for (const path of ["instruction.md", "task.toml", "definition.json"]) {
    const found = files.find((file) => file.path === path && file.text !== undefined);
    if (found) return found;
  }
  return files.find((file) => file.text !== undefined) ?? files[0];
}

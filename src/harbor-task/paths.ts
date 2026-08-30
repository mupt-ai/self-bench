import { posix, resolve, sep } from "node:path";
import type { TaskDefinition } from "../contracts.js";
import { patchPaths } from "../repair.js";

export function assertSafeTaskPaths(task: TaskDefinition): void {
  for (const path of [
    task.workdir,
    ...task.testPaths.map((value) => posix.join(task.workdir, value)),
  ]) {
    const resolved = resolve("/repo", path);
    if (
      (resolved !== "/repo" && !resolved.startsWith(`/repo${sep}`)) ||
      resolved === `/repo${sep}.git` ||
      resolved.startsWith(`/repo${sep}.git${sep}`)
    ) {
      throw new Error(`task path escapes repository: ${path}`);
    }
  }
}

export function assertSafePatchPaths(patch: string, label = "patch"): void {
  const paths = patchPaths(patch);
  if (paths.length === 0) {
    throw new Error(`${label} changes no files`);
  }
  for (const path of paths) {
    const resolved = resolve("/repo", path);
    if (
      resolved === "/repo" ||
      !resolved.startsWith(`/repo${sep}`) ||
      resolved.startsWith(`/repo${sep}.git${sep}`) ||
      resolved === `/repo${sep}.git`
    ) {
      throw new Error(`${label} path escapes repository: ${path}`);
    }
  }
}

export function repositoryRelativePath(task: TaskDefinition, path: string): string {
  return posix.normalize(posix.join(task.workdir, path)).replace(/^\.\//, "");
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

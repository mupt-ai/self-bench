import { posix, resolve, sep } from "node:path";
import type { TaskDefinition } from "../../contracts/index.js";
import { patchPaths } from "../../lib/patch-paths.js";

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

/**
 * Repository paths of the files that pass-to-pass selectors name (a pytest `::` suffix is dropped).
 * The verifier grades these at their base version. Selectors that resolve to a directory, a
 * package, or no tracked file are skipped at verify time, since only tracked files are restored.
 */
export function passToPassTestPaths(task: TaskDefinition): readonly string[] {
  const paths = task.passToPass.flatMap((selector) => {
    const file = selector.split("::")[0];
    if (!file || file.startsWith("-")) return [];
    const path = repositoryRelativePath(task, file);
    return path === "." || path === ".." || path.startsWith("../") ? [] : [path];
  });
  return [...new Set(paths)].sort();
}

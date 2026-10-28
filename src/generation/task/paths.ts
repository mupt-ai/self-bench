import { resolve, sep } from "node:path";
import { patchPaths } from "../../lib/patch-paths.js";

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

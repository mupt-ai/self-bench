export function patchPaths(patch: string): readonly string[] {
  const paths = new Set<string>();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("diff --git ")) {
      continue;
    }
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) {
      throw new Error(`unsupported Git patch header: ${line}`);
    }
    paths.add(match[1]);
    paths.add(match[2]);
  }
  return [...paths].sort();
}

export function assertRepairPaths(
  originalTestPatch: string,
  changedPaths: readonly string[],
): void {
  const allowed = new Set(patchPaths(originalTestPatch));
  if (allowed.size === 0) {
    throw new Error("original held-out test patch changes no files");
  }
  const outside = changedPaths.filter((path) => !allowed.has(path));
  if (outside.length > 0) {
    throw new Error(`repair changed files outside the held-out tests: ${outside.join(", ")}`);
  }
}

export function assertRepairedPatchPaths(
  originalTestPatch: string,
  repairedTestPatch: string,
): void {
  const original = new Set(patchPaths(originalTestPatch));
  const repaired = patchPaths(repairedTestPatch);
  assertRepairPaths(originalTestPatch, repaired);
  const retained = new Set(repaired);
  const missing = [...original].filter((path) => !retained.has(path));
  if (missing.length > 0) {
    throw new Error(`repair removed held-out test paths: ${missing.join(", ")}`);
  }
}

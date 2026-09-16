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

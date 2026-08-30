import { posix } from "node:path";

export function goldPatchChangesDependencyManifests(patch: string): boolean {
  return dependencyManifestPatch(patch).length > 0;
}

export function dependencyManifestPatch(patch: string): string {
  const sections = patch.split(/(?=^diff --git )/m);
  const selected = sections.filter((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
    return match?.[2] ? isDependencyManifest(match[2]) : false;
  });
  return selected.length > 0 ? `${selected.join("").trimEnd()}\n` : "";
}

function isDependencyManifest(path: string): boolean {
  const name = posix.basename(path);
  return (
    /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno\.lock)$/.test(
      name,
    ) ||
    /^(?:pyproject\.toml|uv\.lock|poetry\.lock|Pipfile(?:\.lock)?|requirements[^/]*\.txt)$/.test(
      name,
    ) ||
    /^(?:go\.(?:mod|sum)|Cargo\.(?:toml|lock))$/.test(name)
  );
}

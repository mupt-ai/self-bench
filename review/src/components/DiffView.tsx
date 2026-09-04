import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import React from "react";

export function DiffView({ patch }: { patch: string }) {
  return (
    <DiffErrorBoundary key={patch} fallback={patch}>
      <RenderedPatch patch={patch} />
    </DiffErrorBoundary>
  );
}

export function patchStats(patch: string): { files: number; added: number; removed: number } {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files, added, removed };
}

export function patchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (match?.[2]) paths.push(match[2]);
  }
  return paths;
}

function RenderedPatch({ patch }: { patch: string }) {
  const files = React.useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  if (!files.length) return <pre className="prose">{patch}</pre>;
  const options = {
    themeType: "dark" as const,
    diffStyle: window.matchMedia("(max-width: 1200px)").matches
      ? ("unified" as const)
      : ("split" as const),
    diffIndicators: "bars" as const,
    overflow: "scroll" as const,
    stickyHeader: true,
  };
  return (
    <div className="patch-files">
      {files.map((file) => (
        <FileDiff
          key={`${file.prevName ?? ""}:${file.name}`}
          fileDiff={file}
          disableWorkerPool
          options={options}
        />
      ))}
    </div>
  );
}

class DiffErrorBoundary extends React.Component<
  React.PropsWithChildren<{ fallback: string }>,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("diff renderer failed", error);
  }

  render() {
    return this.state.failed ? (
      <pre className="prose">{this.props.fallback}</pre>
    ) : (
      this.props.children
    );
  }
}

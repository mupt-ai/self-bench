import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import React from "react";
import { prose } from "./viewer-ui";

export function DiffView({ patch }: { patch: string }) {
  return (
    <DiffErrorBoundary key={patch} fallback={patch}>
      <RenderedPatch patch={patch} />
    </DiffErrorBoundary>
  );
}

function RenderedPatch({ patch }: { patch: string }) {
  const files = React.useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  if (!files.length) return <pre className={prose}>{patch}</pre>;
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
    <div className="flex flex-col gap-3 p-3 site:gap-4 site:px-0">
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
      <pre className={prose}>{this.props.fallback}</pre>
    ) : (
      this.props.children
    );
  }
}

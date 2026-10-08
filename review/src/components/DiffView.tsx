import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import React from "react";
import { useTheme } from "../web/use-theme";
import { prose } from "./viewer-ui";

export function DiffView({ patch }: { patch: string }) {
  return (
    <DiffErrorBoundary key={patch} fallback={patch}>
      <RenderedPatch patch={patch} />
    </DiffErrorBoundary>
  );
}

/** The narrowest pane that shows a diff side by side; narrower, the two sides stack. */
const SPLIT_WIDTH = 1000;

function RenderedPatch({ patch }: { patch: string }) {
  const files = React.useMemo(
    () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
    [patch],
  );
  const theme = useTheme();
  const box = React.useRef<HTMLDivElement>(null);
  const [split, setSplit] = React.useState(false);
  // Sized by the pane it is in, not the screen: the same diff sits in a page and in a dialog.
  React.useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSplit((entry?.contentRect.width ?? 0) >= SPLIT_WIDTH),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (!files.length) return <pre className={prose}>{patch}</pre>;
  const options = {
    themeType: theme,
    diffStyle: split ? ("split" as const) : ("unified" as const),
    diffIndicators: "bars" as const,
    overflow: "scroll" as const,
    stickyHeader: true,
  };
  return (
    <div ref={box} className="flex flex-col gap-4 py-3">
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

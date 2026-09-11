import React from "react";
import { createRoot } from "react-dom/client";
import "./theme.css";
import { App } from "./App";
import type { ViewerInfo } from "./types";
import { WebApp } from "./web/WebApp";

const root = document.getElementById("root");
if (!root) {
  throw new Error("review root is missing");
}

/**
 * The signed-in site is the default. The legacy Ledger is retained only for an explicit
 * non-GitHub viewer response from `self-bench view`; an unavailable probe must never expose it.
 */
function Boot() {
  const [site, setSite] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void requiresSignIn().then((found) => {
      if (!cancelled) setSite(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  if (site === null)
    return (
      <div role="status" aria-label="Loading Application" className="space-y-7 p-8">
        <span className="sr-only">Loading application…</span>
        <div
          aria-hidden="true"
          className="h-7 w-44 animate-pulse bg-(--border) motion-reduce:animate-none"
        />
        <div
          aria-hidden="true"
          className="h-48 animate-pulse border border-(--border) bg-(--card) motion-reduce:animate-none"
        />
      </div>
    );
  return site ? <WebApp /> : <App />;
}

async function requiresSignIn(): Promise<boolean> {
  try {
    const response = await fetch("/v1/viewer");
    if (!response.ok) return true;
    const info = (await response.json()) as ViewerInfo;
    return info.auth === "github";
  } catch {
    // If the probe is unavailable, fail closed to the sign-in app rather than the legacy viewer.
    return true;
  }
}

createRoot(root).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);

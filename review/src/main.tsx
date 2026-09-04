import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import type { ViewerInfo } from "./types";
import { WebApp } from "./web/WebApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("review root is missing");
}

/**
 * One bundle, two hosts. A server that requires GitHub sign-in answers the viewer probe with
 * `auth: "github"` and gets selfbench.dev; `self-bench view` and the token API get the Ledger.
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
  if (site === null) return null;
  return site ? <WebApp /> : <App />;
}

async function requiresSignIn(): Promise<boolean> {
  try {
    const response = await fetch("/v1/viewer");
    if (!response.ok) return false;
    const info = (await response.json()) as ViewerInfo;
    return info.auth === "github";
  } catch {
    return false;
  }
}

createRoot(root).render(
  <React.StrictMode>
    <Boot />
  </React.StrictMode>,
);

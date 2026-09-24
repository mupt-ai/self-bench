import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "../src/public-site/theme.css";
import { apiSource } from "../src/public-site/api-source";
import { installHistoryTransitions } from "../src/public-site/effects/history-transitions";
import { fixtureSource } from "../src/public-site/fixture-source";
import { syntheticSource } from "../src/public-site/mobile/checks/synthetic";
import { PublicRoutes } from "../src/public-site/PublicRoutes";
import { SourceContext } from "../src/public-site/source-context";

const root = document.getElementById("root");
if (!root) throw new Error("public site root is missing");

// Development reads local fixtures, or the API with VITE_PUBLIC_DATA=api, or the phone checks'
// made-up repositories with VITE_PUBLIC_DATA=synthetic. A build always reads the API.
const data = import.meta.env.DEV ? import.meta.env.VITE_PUBLIC_DATA : "api";
const source =
  data === "api" ? apiSource() : data === "synthetic" ? syntheticSource() : fixtureSource();

// Before the router, so back and forward can freeze the old page before it is replaced.
installHistoryTransitions();
// The window scrolls the page, and the home page puts back its own scroll on return (see
// home-view.ts); the browser's restoring it as well would fight that.
history.scrollRestoration = "manual";

createRoot(root).render(
  <StrictMode>
    <SourceContext.Provider value={source}>
      <BrowserRouter>
        <PublicRoutes />
      </BrowserRouter>
    </SourceContext.Provider>
  </StrictMode>,
);

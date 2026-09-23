import { useSyncExternalStore } from "react";
import type { Theme } from "../public-site/theme";

function subscribe(onChange: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

function current(): Theme {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** The theme applied to the document, for renderers that cannot read CSS variables. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => "light");
}

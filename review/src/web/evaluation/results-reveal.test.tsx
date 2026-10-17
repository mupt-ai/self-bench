import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { ResultsTable } from "./ResultsTable";
import { credentials, passed, run } from "./results-fixture";

test("a run link reveals the run and leaves the address once", async () => {
  const browser = new Window({ url: "https://selfbench.test/repos/o/r/results?run=one" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    sessionStorage: browser.sessionStorage,
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  // Safari refuses more than 100 replacements in 10 seconds; a loop would reach it here.
  let replacements = 0;
  const replaceState = browser.history.replaceState.bind(browser.history);
  browser.history.replaceState = (...args: Parameters<typeof replaceState>) => {
    replacements += 1;
    if (replacements > 100) throw new Error("replaceState called more than 100 times");
    replaceState(...args);
  };
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <BrowserRouter>
          <ResultsTable
            runs={[run("one", {}, [passed("task-1")])]}
            credentials={credentials}
            baseUrl="/api/evaluations"
            pages="/repos/o/r"
          />
        </BrowserRouter>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(replacements).toBeLessThanOrEqual(2);
    expect(browser.location.href).toBe("https://selfbench.test/repos/o/r/results");
    // Revealed: the run's configuration and the run itself are open.
    expect(container.querySelector('[data-run-id="one"]')).not.toBeNull();
  } finally {
    await act(async () => {
      root.unmount();
    });
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

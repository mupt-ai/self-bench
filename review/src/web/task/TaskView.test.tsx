import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskSource } from "../../sources/types";
import { TaskView } from "./TaskView";

const source: TaskSource = {
  kind: "local",
  label: "test",
  rows: [],
  loadFiles: async (id) => ({ taskId: id, files: [] }),
};

test("the feedback tab is available on task pages without changing other task viewers", () => {
  const row = { id: "task", name: "task" };
  const withFeedback = renderToStaticMarkup(
    <TaskView source={source} row={row} feedback={<p>Feedback Form</p>} />,
  );
  expect(withFeedback).toContain('aria-selected="false">Feedback</button>');

  const withoutFeedback = renderToStaticMarkup(<TaskView source={source} row={row} />);
  expect(withoutFeedback).not.toContain('role="tab">Feedback</button>');
});

test("a status poll on a task without files keeps the tab the person opened", async () => {
  const { Window } = await import("happy-dom");
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const browser = new Window({ url: "https://selfbench.test" });
  const globals = {
    window: browser,
    document: browser.document,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  try {
    // The task page builds a new source on every poll, with no bundles yet.
    const polled = (): TaskSource => ({
      ...source,
      artifacts: async () => ({
        runId: "run",
        taskId: "task",
        candidateId: "task",
        groups: {
          review: [],
          verification: [],
          verify: [],
          authoring: [],
          environments: [],
          audits: [],
          "environment-preflights": [],
          validation: [],
          "validation-repairs": [],
          reviews: [],
          repairs: [],
          provenance: [],
          conversion: [],
        },
        bundles: [],
        agents: [],
      }),
    });
    const row = { id: "task", name: "task" };
    const variants = { count: 2, sheet: <p>Variant List</p> };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = async (current: TaskSource) => {
      await act(async () =>
        root.render(<TaskView source={current} row={row} variants={variants} />),
      );
      await act(async () => {
        await Promise.resolve();
      });
    };
    await render(polled());
    const selected = () => container.querySelector('[aria-selected="true"]')?.textContent;
    expect(selected()).toBe("Pipeline");
    const tab = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Variants"),
    );
    await act(async () => tab?.click());
    expect(selected()).toBe("Variants · 2");
    await render(polled());
    expect(selected()).toBe("Variants · 2");
    expect(container.textContent).toContain("Variant List");
    await act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});

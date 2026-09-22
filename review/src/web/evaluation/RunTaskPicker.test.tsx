import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import type { ComparisonDraft } from "../../../../src/evaluation/comparisons";
import { RunTaskPicker } from "./RunTaskPicker";

test("individual task deselection removes slash-containing task IDs", async () => {
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const availableTasks = [
    { runId: "run/one", taskId: "task/one", difficulty: "easy" as const },
    { runId: "run/two", taskId: "task/two", difficulty: "hard" as const },
  ];
  function Picker() {
    const [tasks, setTasks] = useState<ComparisonDraft["tasks"]>(availableTasks);
    return (
      <MemoryRouter>
        <RunTaskPicker
          repo="owner/repo"
          availableTasks={availableTasks}
          draft={{
            id: "draft",
            tasks,
            models: [],
            sandbox: "e2b",
            sandboxCredentialId: "",
          }}
          tasksReady
          canRun
          disabled={false}
          onChange={setTasks}
          onSkipCompleted={() => {}}
          onRunMissing={() => {}}
        />
      </MemoryRouter>
    );
  }
  try {
    await act(async () => root.render(<Picker />));
    const first = browser.document.querySelector('input[aria-label="Select task/one"]');
    const second = browser.document.querySelector('input[aria-label="Select task/two"]');
    if (
      !(first instanceof browser.HTMLInputElement) ||
      !(second instanceof browser.HTMLInputElement)
    )
      throw new Error("Missing task checkboxes");
    expect(first.checked).toBe(true);
    expect(second.checked).toBe(true);
    await act(async () => first.click());
    expect(first.checked).toBe(false);
    expect(second.checked).toBe(true);
    expect(browser.document.querySelector("summary")?.textContent).toContain("1 Accepted Task");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});

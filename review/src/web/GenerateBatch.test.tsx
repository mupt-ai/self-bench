import { expect, mock, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { GenerateBatch } from "./GenerateBatch";

test("batch dialog starts once, shows progress, and preserves the batch when reopened", async () => {
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
  const base = "/api/orgs/team/repos/owner/repo/batches";
  const start = Promise.withResolvers<Response>();
  const progress = Promise.withResolvers<Response>();
  const onStarted = mock(() => {});
  const submissions: unknown[] = [];
  let started = false;
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    if (String(input) === base && init?.method === "POST") {
      submissions.push(JSON.parse(String(init.body)));
      started = true;
      return start.promise;
    }
    if (String(input) === base)
      return Response.json({ batches: started ? [{ runId: "batch-test" }] : [] });
    if (String(input) === `${base}/batch-test`) return progress.promise;
    throw new Error(`Unexpected request: ${input}`);
  }) as typeof globalThis.fetch);
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (item) => item.textContent?.trim() === label,
    );
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  try {
    await act(async () => {
      root.render(
        <GenerateBatch repoId={{ org: "team", fullName: "owner/repo" }} onStarted={onStarted} />,
      );
    });
    await act(async () => button("Generate Batch").click());
    expect(container.querySelector("dialog")?.open).toBe(true);
    for (const label of ["Easy Candidates", "Medium Candidates", "Hard Candidates"])
      expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull();
    await act(async () => {
      browser.document
        .querySelector("form")
        ?.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submissions).toEqual([{ candidateCounts: { easy: 1, medium: 1, hard: 1 } }]);
    expect(button("Close").disabled).toBe(true);
    const cancel = new browser.Event("cancel", { cancelable: true });
    await act(async () => browser.document.querySelector("dialog")?.dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(container.querySelector("dialog")?.open).toBe(true);
    await act(async () => start.resolve(Response.json({ runId: "batch-test" })));
    expect(container.querySelector('[aria-label="Loading Batch Progress"]')).not.toBeNull();
    await act(async () =>
      progress.resolve(
        Response.json({
          runId: "batch-test",
          phase: "complete",
          accepted: 1,
          discovered: 1,
          tasks: [
            { candidateId: "candidate", taskId: "task", difficulty: "easy", status: "accepted" },
          ],
        }),
      ),
    );
    expect(onStarted).toHaveBeenCalled();
    expect(container.textContent).toContain("Needs Review");
    expect(container.querySelector('[aria-label="Loading Batch Progress"]')).toBeNull();
    await act(async () => button("Close").click());
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () => button("Generate Batch").click());
    expect(container.textContent).toContain("batch-test");
    expect(submissions).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});

import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BatchProvider, useBatches } from "./BatchProvider";

function Probe() {
  const { runs, statuses, errors, revision } = useBatches();
  return <output>{JSON.stringify({ runs, statuses, errors, revision })}</output>;
}

test("repository history polls active batches, preserves terminal status and retries failed refreshes", async () => {
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
  const root = createRoot(container);
  let phase = "discovering",
    fail = false,
    statusCalls = 0;
  let tick: (() => void) | undefined;
  const originalTimeout = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    if (delay === 5000 || delay === 15000) {
      tick = () => callback(...args);
      return originalTimeout(callback, 60_000, ...args);
    }
    return originalTimeout(callback, delay, ...args);
  }) as typeof setTimeout);
  const fetch = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    if (String(input).endsWith("/batches"))
      return Response.json({
        batches: [{ runId: "batch-one", attachedAt: "2026-09-09T20:00:00Z", attachedBy: "owner" }],
      });
    statusCalls++;
    return fail
      ? Response.json({ error: "Status unavailable" }, { status: 503 })
      : Response.json({ runId: "batch-one", phase });
  }) as typeof globalThis.fetch);
  const snapshot = () => JSON.parse(container.querySelector("output")?.textContent ?? "{}");
  try {
    await act(async () =>
      root.render(
        <BatchProvider repoId={{ org: "team", fullName: "owner/repo" }}>
          <Probe />
        </BatchProvider>,
      ),
    );
    expect(snapshot().statuses["batch-one"].phase).toBe("discovering");
    expect(snapshot().revision).toBe(1);
    phase = "blocked";
    await act(async () => tick?.());
    expect(snapshot().statuses["batch-one"].phase).toBe("blocked");
    expect(snapshot().revision).toBe(2);
    expect(statusCalls).toBe(2);
    await act(async () => tick?.());
    expect(statusCalls).toBe(2);
    fail = true;
    await act(async () => browser.dispatchEvent(new browser.Event("focus")));
    expect(snapshot().statuses["batch-one"].phase).toBe("blocked");
    expect(snapshot().errors["batch-one"]).toBe("Status unavailable");
    fail = false;
    await act(async () => tick?.());
    expect(snapshot().errors).toEqual({});
    expect(snapshot().revision).toBe(2);
    expect(statusCalls).toBe(4);
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    timer.mockRestore();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await browser.happyDOM.close();
  }
});

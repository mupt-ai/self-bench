import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { VerifyRound } from "../lib/verify-rounds";
import type { TaskSource } from "../sources/types";
import { VerifyPart } from "./VerifyPart";

async function render(round: VerifyRound, files: Record<string, string>, active: boolean) {
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
  const source = {
    kind: "run",
    label: "run",
    rows: [],
    loadFiles: async () => ({ taskId: "task", files: [] }),
    readArtifact: async (key: string) => files[key] ?? "",
  } as TaskSource;
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<VerifyPart round={round} source={source} active={active} />));
  await act(async () => {
    await Promise.resolve();
  });
  const html = container.innerHTML;
  await act(async () => root.unmount());
  // Later test files check for a real DOM; leave the globals as they were.
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  await browser.happyDOM.close();
  return html;
}

test("a running check shows the running step, elapsed time, and Harbor milestones", async () => {
  const live = "verify/live/nop-000003.json";
  const html = await render(
    {
      id: "authoring-round-1-turn-1",
      title: "Verify Part 1, Turn 1",
      startedAt: "2026-09-24T01:14:10Z",
      live: { key: live, sizeBytes: 1 },
      steps: [
        { label: "Compile", state: "done" },
        { label: "Build, Smoke, and Tests Without Fix", state: "running" },
        { label: "Tests With Fix", state: "pending" },
      ],
    },
    {
      [live]: JSON.stringify({
        run: "nop",
        startedAt: "2026-09-24T01:14:20Z",
        capturedAt: "2026-09-24T01:21:32Z",
        steps: ["Selected strategy: _ModalDirect", "Collect hook in service 'main' completed"],
        output: "",
      }),
    },
    true,
  );
  expect(html).toContain("Verify Part 1, Turn 1");
  expect(html).toContain("In Progress");
  expect(html).toContain("Running · 7m 12s");
  expect(html).toContain("Collect hook in service 'main' completed");
});

test("a finished check shows each gate's result and the report", async () => {
  const report = {
    green: false,
    compile: { ok: true, errors: [] },
    audit: { ok: true, blockers: [] },
    build: { ran: true, ok: true },
    smoke: { ran: true, ok: false },
    nop: { ran: false, ok: false },
    oracle: { ran: false, ok: false },
  };
  const html = await render(
    {
      id: "authoring-round-1",
      title: "Verify Part 1 Submission",
      startedAt: "2026-09-24T02:00:00Z",
      report: { key: "verify/report.json", sizeBytes: 1 },
      reportText: { key: "verify/report.md", sizeBytes: 1 },
      steps: [],
    },
    {
      "verify/report.json": JSON.stringify(report),
      "verify/report.md": "Overall: **RED** — smoke failed",
    },
    false,
  );
  expect(html).toContain("Failed");
  expect(html).toContain("Image Build");
  expect(html).toContain("Not Run");
  expect(html).toContain("Overall: **RED** — smoke failed");
});

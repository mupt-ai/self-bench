import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { RunExecution, runBlocker } from "./RunExecution";

function renderExecution(ready: boolean, pairs: number) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RunExecution
        returnTo="/repos/mupt-ai/self-bench/run"
        draft={{
          id: "preview",
          tasks: [{ runId: "batch", taskId: "task" }],
          models: [],
          sandbox: "e2b",
          sandboxCredentialId: ready ? "sandbox" : "",
        }}
        credentials={[]}
        sandboxes={["e2b"]}
        submitted={false}
        busy={false}
        ready={ready}
        pairs={pairs}
        onChange={() => {
          throw new Error("Render must not change a draft");
        }}
        onSubmit={() => {
          throw new Error("Render must not start an evaluation");
        }}
        onRunMissing={() => {
          throw new Error("Render must not start an evaluation");
        }}
      />
    </MemoryRouter>,
  );
}

/** The Full Comparison button's opening tag; placeholder options are disabled too. */
function fullButton(html: string): string {
  return html.match(/<button[^>]*>(?=(?:(?!<\/button>)[\s\S])*Run Full Comparison)/)?.[0] ?? "";
}

test("the run page explains why a run is unavailable, once tasks load", () => {
  const draft = {
    id: "preview",
    tasks: [{ runId: "batch", taskId: "task" }],
    models: [],
    sandbox: "e2b" as const,
    sandboxCredentialId: "",
  };
  const blocker = (overrides: Partial<Parameters<typeof runBlocker>[0]>) =>
    runBlocker({ draft, ready: false, submitted: false, tasksReady: true, pairs: 0, ...overrides });
  expect(blocker({ tasksReady: false })).toBeUndefined();
  expect(blocker({ draft: { ...draft, tasks: [] } })).toBe(
    "Select at least one accepted task to continue.",
  );
  expect(blocker({})).toBe("Add a model to continue.");
  expect(blocker({ pairs: 2 })).toBe("Select a sandbox credential to continue.");
  expect(blocker({ pairs: 2, ready: true })).toBeUndefined();
  expect(fullButton(renderExecution(false, 2))).toContain('disabled=""');
});

test("managed execution hides provider credentials and does not name its backend", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunExecution
        returnTo="/repos/mupt-ai/self-bench/run"
        draft={{
          id: "preview",
          tasks: [],
          models: [],
          sandbox: "managed",
          sandboxCredentialId: "managed-sandbox",
        }}
        credentials={[]}
        sandboxes={["managed", "e2b"]}
        submitted={false}
        busy={false}
        ready={true}
        pairs={1}
        onChange={() => {}}
        onSubmit={() => {}}
        onRunMissing={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('value="managed" selected=""');
  expect(html).not.toContain("Sandbox Credential");
  expect(html).toContain("SelfBench&#x27;s platform account");
});

test("ready execution shows the trial total and enables the run action", () => {
  const html = renderExecution(true, 2);
  expect(html).toContain("Total Trials");
  expect(html).toContain(">2</dd>");
  expect(fullButton(html)).toMatch(/^<button/);
  expect(fullButton(html)).not.toContain('disabled=""');
  expect(html.indexOf("Run Missing Tasks")).toBeLessThan(html.indexOf("Run Full Comparison"));
});

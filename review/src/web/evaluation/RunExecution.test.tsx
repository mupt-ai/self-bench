import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { RunExecution } from "./RunExecution";

function renderExecution(ready: boolean, pairs: number, tasksReady = true) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <RunExecution
        repo="mupt-ai/self-bench"
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
        tasksReady={tasksReady}
        pairs={pairs}
        onChange={() => {
          throw new Error("Render must not change a draft");
        }}
        onSubmit={() => {
          throw new Error("Render must not start an evaluation");
        }}
      />
    </MemoryRouter>,
  );
}

/** The Run Comparison button's opening tag; placeholder options are disabled too, so the
 * panel as a whole always contains a disabled attribute. */
function runButton(html: string): string {
  return html.match(/<button[^>]*>(?=(?:(?!<\/button>)[\s\S])*Run Comparison)/)?.[0] ?? "";
}

test("execution explains why a run is unavailable", () => {
  expect(renderExecution(false, 0, false)).toContain("Accepted tasks are required to run.");
  expect(renderExecution(false, 0)).toContain("Add a model to continue.");
  expect(renderExecution(false, 2)).toContain("Select a sandbox credential to continue.");
  expect(runButton(renderExecution(false, 2))).toContain('disabled=""');
});

test("managed execution hides provider credentials and does not name its backend", () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <RunExecution
        repo="mupt-ai/self-bench"
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
        tasksReady={true}
        pairs={1}
        onChange={() => {}}
        onSubmit={() => {}}
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
  expect(runButton(html)).toMatch(/^<button/);
  expect(runButton(html)).not.toContain('disabled=""');
  expect(html).toContain("Model and sandbox usage is billed by your providers.");
});

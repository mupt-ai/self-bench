import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ReleaseView } from "./api";
import { Unsolved } from "./ReleaseNotes";
import { selectionOf } from "./selection";

const task = (taskId: string, unsolved?: number) => ({
  key: taskId,
  runId: "gen",
  taskId,
  difficulty: "easy" as const,
  status: "new" as const,
  ...(unsolved ? { unsolved } : {}),
});

const view: ReleaseView = {
  preview: {
    fingerprint: "f".repeat(64),
    tasks: [task("t0"), task("t1", 4)],
    removed: [],
    unrun: 0,
    settings: [
      {
        key: "a",
        id: "a",
        catalogId: "a",
        modelName: "a",
        label: "a",
        harness: "codex",
        reasoningLevel: "high",
        provider: "openai",
        custom: false,
        coverage: [0, 1],
        ticked: true,
      },
    ],
  },
  head: null,
  current: null,
};

const render = (ticked: string[]) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <Unsolved view={view} selection={selectionOf(view.preview, new Set(ticked))} repo="o/r" />
    </MemoryRouter>,
  );

test("unsolved tasks in the selection are listed with links to their pages", () => {
  const html = render(["a"]);
  expect(html).toContain("No setting passed 1 task");
  expect(html).toContain('href="/repos/o/r/tasks/gen/t1"');
  expect(html).toContain("None of the 4 settings with an eligible result on this task passed");
  expect(html).not.toContain(">t0<");
  expect(render([])).toBe("");
});

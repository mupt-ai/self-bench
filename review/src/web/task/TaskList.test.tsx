import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { TaskItem } from "../api";
import { TaskList } from "./TaskList";

test("deletion controls sit outside task links and active generation stays disabled even when approved", () => {
  const tasks = [
    {
      runId: "run-one",
      taskId: "terminal",
      pipelineStatus: "accepted",
      state: "needs_review",
      difficulty: "easy",
    },
    {
      runId: "run-two",
      taskId: "active",
      pipelineStatus: "in_progress",
      state: "accepted",
      difficulty: "easy",
    },
  ] as TaskItem[];
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <TaskList
        fullName="owner/repo"
        tasks={tasks}
        selected={new Set(["run-one:terminal"])}
        busy={false}
        onSelect={() => {}}
        onDelete={() => {}}
      />
    </MemoryRouter>,
  );
  expect(html).toContain('aria-label="Select terminal from run-one" checked=""');
  expect(html).toMatch(/aria-label="Select active from run-two" disabled=""/);
  expect(html).toMatch(/aria-label="Task Actions for active from run-two" disabled=""/);
  const links = html.match(/<a\b[^>]*>.*?<\/a>/g) ?? [];
  expect(links).toHaveLength(2);
  expect(links.every((link) => !link.includes("<button") && !link.includes("<input"))).toBe(true);
});

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

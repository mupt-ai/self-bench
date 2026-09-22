import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "./ui";

const messages = [
  "No tasks yet. Add a PR to generate a task.",
  "No tasks match.",
  "No repositories connected. Connect a repository to get started.",
  "No repositories match.",
  "No repositories here.",
];

test.each(messages)("empty-state styling stays consistent for: %s", (message) => {
  const html = renderToStaticMarkup(<EmptyState title="No Results">{message}</EmptyState>);
  expect(html).toContain("panel");
  expect(html).toContain("No Results");
  expect(html).toContain(message);
  expect(html).not.toContain("min-h-");
});

test("empty-state copy is escaped, not interpreted as markup", () => {
  const html = renderToStaticMarkup(
    <EmptyState title="No Results">{"No results for <repo>."}</EmptyState>,
  );
  expect(html).toContain("No results for &lt;repo&gt;.");
});

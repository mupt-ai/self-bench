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
  const html = renderToStaticMarkup(<EmptyState>{message}</EmptyState>);
  expect(html).toBe(
    `<div class="w-full border border-dashed border-line-strong px-4 py-6 text-center font-mono text-sm leading-6 text-muted"><p>${message}</p></div>`,
  );
});

test("empty-state copy is escaped, not interpreted as markup", () => {
  const html = renderToStaticMarkup(<EmptyState>{"No results for <repo>."}</EmptyState>);
  expect(html).toContain("No results for &lt;repo&gt;.");
});

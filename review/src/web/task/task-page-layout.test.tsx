import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { TaskSkeleton } from "./TaskSkeleton";

test("loaded task and skeleton keep a fixed-height frame instead of growing with file content", () => {
  const source = readFileSync(new URL("../pages/TaskPage.tsx", import.meta.url), "utf8");
  const frame = source.match(/<div className="([^"]*h-\[calc\(100dvh-56px\)\][^"]*)"/)?.[1];
  expect(frame).toBeDefined();
  const classes = frame?.split(" ");
  expect(classes).toContain("flex-none");
  expect(classes).toContain("overflow-hidden");
  expect(classes).toContain("grid-rows-[auto_minmax(0,1fr)]");
  expect(classes).not.toContain("flex-1");

  const skeleton = renderToStaticMarkup(
    <MemoryRouter>
      <TaskSkeleton fullName="pallets/click" taskId="click-short-help-abbreviations" />
    </MemoryRouter>,
  );
  expect(skeleton).toContain(`class="${frame}"`);
});

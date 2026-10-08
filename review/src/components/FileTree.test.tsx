import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FileTree } from "./FileTree";

const files = [
  { path: "instruction.md", sizeBytes: 1536, text: "# Task" },
  { path: "tests/test.sh", sizeBytes: 512, text: "bun test" },
  { path: "environment/repo.tar.gz", sizeBytes: 50_864_456 },
  { path: "tests/runtime/command.sh", sizeBytes: 20_000, text: "run" },
];

const render = (current: string | null) =>
  renderToStaticMarkup(<FileTree files={files} current={current} onOpen={() => undefined} />);

test("groups files under their folders, folders first, each level by name", () => {
  const html = render(null);
  const order = [
    "environment/",
    "repo.tar.gz",
    "tests/",
    "runtime/",
    "command.sh",
    "test.sh",
    "instruction.md",
  ].map((label) => html.indexOf(`>${label}<`));

  expect(order).not.toContain(-1);
  expect(order).toEqual([...order].sort((left, right) => left - right));
});

test("sizes read as a person would say them", () => {
  const html = render(null);

  for (const size of ["512 B", "1.5 KB", "20 KB", "49 MB"]) expect(html).toContain(`>${size}<`);
});

test("marks only the open file as current", () => {
  const html = render("tests/runtime/command.sh");

  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  expect(html).toMatch(/aria-current="true"[^>]*title="tests\/runtime\/command\.sh"/);
});

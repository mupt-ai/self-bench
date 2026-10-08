import { expect, test } from "bun:test";
import { firstFile } from "./task-model";

const files = [
  { path: "environment/Dockerfile", sizeBytes: 10, text: "FROM node\n" },
  { path: "environment/repo.tar.gz", sizeBytes: 50_864_456 },
  { path: "task.toml", sizeBytes: 10, text: 'repo = "x/y"\n' },
  { path: "instruction.md", sizeBytes: 10, text: "Do it.\n" },
];

test("a task opens on its instruction, else its config, else its first readable file", () => {
  expect(firstFile(files)?.path).toBe("instruction.md");
  expect(firstFile(files.filter((file) => file.path !== "instruction.md"))?.path).toBe("task.toml");
  expect(firstFile(files.slice(0, 2))?.path).toBe("environment/Dockerfile");
  expect(firstFile(files.slice(1, 2))?.path).toBe("environment/repo.tar.gz");
  expect(firstFile([])).toBeUndefined();
});

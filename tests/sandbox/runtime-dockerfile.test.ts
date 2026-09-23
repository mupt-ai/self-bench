import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseSandboxDockerfile,
  readSandboxDockerfile,
  sandboxDockerfileReference,
} from "../../src/sandbox/runtime-dockerfile.js";

test("the packaged Dockerfile.sandbox splits into a pinned base and its instructions", () => {
  const { base, instructions } = parseSandboxDockerfile(readSandboxDockerfile());
  expect(base).toMatch(/^node:22-bookworm@sha256:[0-9a-f]{64}$/);
  expect(instructions.at(-1)).toBe("WORKDIR /work");
  expect(instructions.some((line) => line.includes("pi-coding-agent"))).toBe(true);
  expect(instructions.every((line) => !line.trimStart().startsWith("#"))).toBe(true);
});

test("continuation lines stay with their instruction", () => {
  const parsed = parseSandboxDockerfile(
    "# comment\nFROM alpine\n\nRUN one \\\n  && two\n# between\nWORKDIR /work\n",
  );
  expect(parsed).toEqual({
    base: "alpine",
    instructions: ["RUN one \\\n  && two", "WORKDIR /work"],
  });
});

test("multi-stage or base-less files are rejected", () => {
  expect(() => parseSandboxDockerfile("RUN true\n")).toThrow("FROM");
  expect(() => parseSandboxDockerfile("FROM a AS b\nRUN true\n")).toThrow("FROM");
  expect(() => parseSandboxDockerfile("FROM a\nFROM b\n")).toThrow("single-stage");
  expect(() => parseSandboxDockerfile("FROM a\nRUN x \\")).toThrow("continued");
});

test("the reference changes with the file contents", async () => {
  const one = await mkdtemp(join(tmpdir(), "selfbench-dockerfile-"));
  const two = await mkdtemp(join(tmpdir(), "selfbench-dockerfile-"));
  await writeFile(join(one, "Dockerfile.sandbox"), "FROM scratch\n");
  await writeFile(join(two, "Dockerfile.sandbox"), "FROM scratch\nRUN true\n");
  expect(sandboxDockerfileReference(one)).toMatch(/^Dockerfile\.sandbox@[0-9a-f]{16}$/);
  expect(sandboxDockerfileReference(one)).not.toBe(sandboxDockerfileReference(two));
});

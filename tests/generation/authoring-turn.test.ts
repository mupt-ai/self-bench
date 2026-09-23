import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESTORE_DRAFT, verifyResultPrompt } from "../../src/generation/pipeline/authoring.js";
import { runCommand } from "../../src/lib/process.js";
import { redReport } from "../support/workflow-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("restoring a draft gives the agent back the four files it wrote", async () => {
  const work = await mkdtemp(join(tmpdir(), "selfbench-restore-"));
  roots.push(work);
  const staged = join(work, "staged");
  await mkdir(staged);
  await writeFile(
    join(staged, "definition.json"),
    `${JSON.stringify({ taskId: "t", prompt: "Implement it." }, null, 2)}\n`,
  );
  await writeFile(join(staged, "test.patch"), "test\n");
  await writeFile(join(staged, "gold.patch"), "gold\n");
  await runCommand("tar", ["-czf", join(work, "draft.tar.gz"), "-C", staged, "."]);

  await runCommand("bash", [
    "-euo",
    "pipefail",
    "-c",
    RESTORE_DRAFT.replaceAll("/work/", `${work}/`),
  ]);

  const task = join(work, "task");
  expect(JSON.parse(await readFile(join(task, "definition.json"), "utf8"))).toEqual({
    taskId: "t",
  });
  expect(await readFile(join(task, "instruction.md"), "utf8")).toBe("Implement it.\n");
  expect(await readFile(join(task, "test.patch"), "utf8")).toBe("test\n");
  expect(await readFile(join(task, "gold.patch"), "utf8")).toBe("gold\n");
});

test("the turn after a verify carries the report and the next step", () => {
  const red = redReport("authoring", 1, "t", { oracle: true });
  expect(verifyResultPrompt(red, 2)).toContain("green=false. 2 verify call(s) remain");
  expect(verifyResultPrompt(red, 2)).toContain("verify again");
  expect(verifyResultPrompt(red, 0)).toContain("call submit_task with your best task");
  expect(verifyResultPrompt({ ...red, green: true }, 1)).toContain("Call submit_task now.");
});

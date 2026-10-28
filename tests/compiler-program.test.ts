import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../src/lib/process.js";
import { submission } from "./support/submission-fixture.js";

const roots: string[] = [];
const program = join(import.meta.dir, "../src/sandbox/programs/compiler.ts");
const candidate = { sourcePr: 1, baseCommit: "a".repeat(40), difficulty: "easy" };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function compile(bundle: (work: string) => Promise<void>) {
  const work = await mkdtemp(join(tmpdir(), "selfbench-compiler-program-"));
  roots.push(work);
  await writeFile(
    join(work, "input.json"),
    JSON.stringify({ repositoryUrl: "https://github.com/example/repo", taskId: "t", candidate }),
  );
  await bundle(work);
  await runCommand(process.execPath, [program], {
    env: { ...process.env, SELFBENCH_COMPILER_WORK: work },
  });
  return JSON.parse(await readFile(join(work, "result.json"), "utf8")) as {
    compileErrors: string[];
  };
}

test("compiler unpacks the submission and reports its author errors", async () => {
  const result = await compile(async (work) => {
    const draft = join(work, "draft");
    await mkdir(draft);
    for (const [name, contents] of Object.entries(submission)) {
      if (name !== "run-tests.sh") await writeFile(join(draft, name), contents);
    }
    await runCommand("tar", ["-czf", join(work, "source-task.tar.gz"), "-C", draft, "."]);
    await rm(draft, { recursive: true });
  });
  expect(result.compileErrors).toEqual(["run-tests.sh is missing or empty"]);
});

test("an unreadable submission bundle is an author error, not a compiler crash", async () => {
  const result = await compile((work) => writeFile(join(work, "source-task.tar.gz"), "not a tar"));
  expect(result.compileErrors[0]).toContain("the submission bundle could not be unpacked");
});

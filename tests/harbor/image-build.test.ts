import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authoredImageBuildFailure } from "../../src/harnesses/harbor/image-build.js";

const failure = "ImageBuildError: Image build for im-abc123 failed.\nView the build logs:";
let directory = "";
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

/** An environment whose `modal` prints `log` for `modal image logs im-abc123`. */
async function modalPrinting(log: string): Promise<NodeJS.ProcessEnv> {
  directory = await mkdtemp(join(tmpdir(), "selfbench-modal-"));
  await writeFile(join(directory, "log.txt"), log);
  const script = join(directory, "modal");
  await writeFile(
    script,
    `#!/bin/sh\n[ "$*" = "image logs im-abc123" ] || exit 2\ncat "${join(directory, "log.txt")}"\n`,
  );
  await chmod(script, 0o755);
  return { PATH: `${directory}:${process.env.PATH ?? ""}` };
}

test("a Dockerfile step that fails is handed to the author with its build log", async () => {
  const env = await modalPrinting(
    'Step 3\nTerminating task due to error: failed to run builder command "/bin/sh setup.sh && command -v pkill": container exit status: 127\n',
  );
  const log = await authoredImageBuildFailure(failure, env, new AbortController().signal);
  expect(log).toContain("Modal image build log (im-abc123)");
  expect(log).toContain("container exit status: 127");
});

test("a build Modal itself failed stays an infrastructure failure", async () => {
  const env = await modalPrinting("Step 0: FROM python\nError: registry timed out\n");
  expect(
    await authoredImageBuildFailure(failure, env, new AbortController().signal),
  ).toBeUndefined();
  expect(
    await authoredImageBuildFailure(
      "ModalError: sandbox unavailable",
      env,
      new AbortController().signal,
    ),
  ).toBeUndefined();
});

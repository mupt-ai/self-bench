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
  const remote = "RemoteError: Image build for im-abc123 failed";
  expect(await authoredImageBuildFailure(remote, env, new AbortController().signal)).toBe(log);
});

const pull = (reason: string) =>
  `=> Step 0: FROM node:22-bookworm@sha256:aa4a\ntime="…" level=fatal msg="initializing source docker://node@sha256:aa4a: ${reason}"\nTerminating task due to error: command skopeo copy docker://node@sha256:aa4a oci:… had exit status: 2\n`;

test("a base image its registry does not serve is handed to the author", async () => {
  const env = await modalPrinting(
    pull("reading manifest sha256:aa4a in docker.io/library/node: manifest unknown"),
  );
  const log = await authoredImageBuildFailure(failure, env, new AbortController().signal);
  expect(log).toContain("manifest unknown");
});

test("a base image pull the registry throttled or denied stays an infrastructure failure", async () => {
  for (const reason of [
    "toomanyrequests: You have reached your pull rate limit",
    "denied: requested access to the resource is denied",
  ]) {
    const env = await modalPrinting(pull(reason));
    expect(
      await authoredImageBuildFailure(failure, env, new AbortController().signal),
    ).toBeUndefined();
  }
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

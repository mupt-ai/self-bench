import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { errorMessage } from "../../lib/util.js";
import { withTemporaryDirectory } from "../../sandbox/temporary.js";
import { WORKSPACE_DIRECTORY } from "../task/scenario-workspace.js";
import { SUBMISSION_FILES } from "../task/submission.js";
import { revisionPrefix, SOURCE_BUNDLE } from "./revision.js";

/**
 * Compressed; base64 in a JSON body it stays under the 32 MiB a Cloud Run request may carry. A
 * workspace near its own limit (MAX_WORKSPACE_BYTES, uncompressed) may not fit: revise it with
 * feedback instead, and its agent edits it in place.
 */
export const MAX_DRAFT_BYTES = 22 * 1024 * 1024;

/**
 * Files an author may hand off, and a legacy task's definition.json, which a revision is asked
 * to replace (maintainer-feedback.md).
 */
const ALLOWED = new Set<string>([...SUBMISSION_FILES, WORKSPACE_DIRECTORY, "definition.json"]);

/**
 * Why a person's edited draft (the task's files as a tar.gz, as GET …/draft gives them) can't be
 * a revision's starting point; empty when it can. It holds only regular files and directories,
 * and nothing but the files an author writes. The author's checks still run on it before any build.
 */
export async function uploadedDraftProblems(bytes: Uint8Array): Promise<string[]> {
  if (bytes.byteLength > MAX_DRAFT_BYTES)
    return [`the draft may be at most ${MAX_DRAFT_BYTES / 1024 / 1024} MB`];
  return await withTemporaryDirectory("selfbench-uploaded-draft-", async (root) => {
    const archive = join(root, "draft.tar.gz");
    const unpacked = join(root, "draft");
    await writeFile(archive, bytes);
    await mkdir(unpacked);
    try {
      await extractRegularArchive(archive, unpacked);
    } catch (error) {
      return [`the draft is not a usable tar.gz: ${errorMessage(error)}`];
    }
    const entries = await readdir(unpacked, { withFileTypes: true });
    const unknown = entries.filter((entry) => !ALLOWED.has(entry.name)).map((entry) => entry.name);
    const problems = unknown.length
      ? [
          `the draft may hold only ${[...ALLOWED].join(", ")} at its top level; remove ${unknown.join(", ")}`,
        ]
      : [];
    const misplaced = entries.filter(
      (entry) =>
        ALLOWED.has(entry.name) && entry.isDirectory() !== (entry.name === WORKSPACE_DIRECTORY),
    );
    for (const entry of misplaced)
      problems.push(
        `${entry.name} must be ${entry.name === WORKSPACE_DIRECTORY ? "a directory" : "a file"}`,
      );
    if (!entries.some((entry) => ALLOWED.has(entry.name)))
      problems.push("the draft holds none of the task's files");
    return problems;
  });
}

/** Stores a checked upload where a revision's starting draft goes (revision.ts). */
export async function stageUploadedDraft(
  store: ArtifactStore,
  runId: string,
  task: { readonly candidateId: string; readonly taskId: string },
  bytes: Uint8Array,
): Promise<AuthoredTaskDraft> {
  const sourceBundle = await store.put(
    `${revisionPrefix(runId, task.candidateId)}/${SOURCE_BUNDLE}`,
    bytes,
    "application/gzip",
  );
  return { candidateId: task.candidateId, taskId: task.taskId, sourceBundle };
}

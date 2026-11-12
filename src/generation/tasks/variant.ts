import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import {
  MAX_ENVIRONMENT_SCRIPT_BYTES,
  MAX_VARIANT_LABEL_LENGTH,
} from "../../contracts/variants.js";
import type { TaskVariantRecord, TaskVariantStore } from "../../db/task-variants.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { runCommand } from "../../lib/process.js";
import { withTemporaryDirectory } from "../../sandbox/temporary.js";
import { revisionPrefix, SOURCE_BUNDLE } from "./revision.js";
import type { TaskWorkflows } from "./workflow-client.js";

/**
 * An environment: a script run in each approved task's image, and nothing else. A task's
 * instruction, hidden tests, and reference solution stay byte for byte the original's.
 */
const environmentSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_VARIANT_LABEL_LENGTH),
    /**
     * Bash, run in /app as the image is built: `rm -f AGENTS.md`, `pnpm add next@15.5.0`. It is the
     * repository's own members' code in their own tasks' images, as each task's Dockerfile is.
     */
    script: z
      .string()
      // Bash reads a carriage return as part of the command it ends.
      .transform((text) => text.replace(/\r\n?/g, "\n"))
      .refine((text) => text.trim().length > 0, "a script of at least one command")
      .refine(
        (text) => Buffer.byteLength(text) <= MAX_ENVIRONMENT_SCRIPT_BYTES,
        `at most ${MAX_ENVIRONMENT_SCRIPT_BYTES / 1024} KB`,
      ),
  })
  .strict();

export type EnvironmentSpec = z.infer<typeof environmentSchema>;

/** POST {repo}/environments: the script, and the generation settings each task's check uses. */
export const environmentRequestSchema = z
  .object({ environment: environmentSchema, generation: z.unknown().optional() })
  .strict();

const SCRIPT_PATH = "/tmp/selfbench-environment.sh";
/** A Dockerfile line holds under 64 KB, so the encoded script is written a few KB to a line. */
const ENCODED_LINE = 4096;

/**
 * The Dockerfile step an environment adds after the author's own: its script, run in /app and
 * stopped at the first command that fails, so a task whose script failed is never built without
 * its change. It runs before SelfBench commits the task's starting tree (render.ts), so both
 * images get it and it never reaches the agent's diff. The script travels base64-encoded, so
 * nothing in it can end the step or start another.
 */
function variantDockerfileSteps(environment: EnvironmentSpec): string {
  const encoded = Buffer.from(environment.script).toString("base64");
  const lines = encoded.match(new RegExp(`.{1,${ENCODED_LINE}}`, "g")) ?? [];
  return [
    `# SelfBench environment: ${environment.name.replace(/[\r\n]/g, " ")}`,
    "RUN printf %s \\",
    ...lines.map((line) => `  '${line}' \\`),
    `  | base64 -d > ${SCRIPT_PATH} && cd /app && bash -e ${SCRIPT_PATH} && rm -f ${SCRIPT_PATH}`,
    "",
  ].join("\n");
}

/**
 * Stores the variant's starting draft in its own run: the original's last submission with the
 * environment's steps appended to its Dockerfile, every other file unchanged.
 */
export async function stageVariantDraft(
  store: ArtifactStore,
  runId: string,
  draft: AuthoredTaskDraft,
  environment: EnvironmentSpec,
): Promise<AuthoredTaskDraft> {
  const bytes = await withTemporaryDirectory("selfbench-variant-", async (root) => {
    const archive = join(root, SOURCE_BUNDLE);
    const unpacked = join(root, "draft");
    await writeFile(archive, await store.get(draft.sourceBundle));
    await mkdir(unpacked);
    await extractRegularArchive(archive, unpacked);
    const dockerfile = join(unpacked, "Dockerfile");
    const authored = await readFile(dockerfile, "utf8");
    await writeFile(dockerfile, `${authored.trimEnd()}\n\n${variantDockerfileSteps(environment)}`);
    const repacked = join(root, "variant.tar.gz");
    await runCommand("tar", ["-czf", repacked, "-C", unpacked, ...(await readdir(unpacked))]);
    return await readFile(repacked);
  });
  const sourceBundle = await store.put(
    `${revisionPrefix(runId, draft.candidateId)}/${SOURCE_BUNDLE}`,
    bytes,
    "application/gzip",
  );
  return { ...draft, sourceBundle };
}

/**
 * Stops the checks of `variants` still running, as their environment or task is deleted: a deleted
 * row's workflow would settle nothing, but keep its sandbox and model spend going until it ended.
 * Each one stopped is settled as stopped (`markStopped`), so a later deletion skips it. Returns how
 * many did not stop, so the deletion can say so and be repeated.
 */
export async function stopVariantChecks(
  variants: readonly Pick<TaskVariantRecord, "id" | "pipelineStatus" | "workflowId">[],
  workflows: Pick<TaskWorkflows, "cancel"> | undefined,
  store: Pick<TaskVariantStore, "markStopped">,
): Promise<number> {
  if (!workflows) return 0;
  const results = await Promise.all(
    variants.flatMap((variant) =>
      variant.pipelineStatus === "in_progress" && variant.workflowId
        ? [
            workflows.cancel(variant.workflowId).then(
              () => variant.id,
              (error: unknown) => {
                console.error(`variant check ${variant.workflowId} did not stop:`, error);
                return undefined;
              },
            ),
          ]
        : [],
    ),
  );
  const stopped = results.filter((id): id is number => id !== undefined);
  await store.markStopped(stopped);
  return results.length - stopped.length;
}

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ArtifactStore } from "../../artifacts/index.js";
import type { AuthoredTaskDraft } from "../../contracts/index.js";
import { MAX_VARIANT_LABEL_LENGTH } from "../../contracts/variants.js";
import { extractRegularArchive } from "../../lib/archive.js";
import { runCommand } from "../../lib/process.js";
import { withTemporaryDirectory } from "../../sandbox/temporary.js";
import { revisionPrefix, SOURCE_BUNDLE } from "./revision.js";

const MAX_FILE_BYTES = 64 * 1024;

/** An npm package name, scoped or not. */
const packageName = z
  .string()
  .trim()
  .regex(/^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, "not an npm package name");
/** A version, range, tag, or URL to a tarball: no spaces or quotes, so it is safe in a shell. */
const packageSpec = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^[A-Za-z0-9._~:/?#@!$&()*+,;=%^<>|[\]-]+$/, "a version, tag, or tarball URL");
/** A path under /app: plain segments, never `..` or Git's own directory. */
const appPath = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/, "a relative path of plain names")
  .refine(
    (path) => path.split("/").every((part) => part !== ".." && part !== "." && part !== ".git"),
    "no . , .. , or .git segments",
  );

/**
 * An environment: changes made to each approved task's files, and nothing else. A task's
 * instruction, hidden tests, and reference solution stay byte for byte the original's.
 */
const environmentSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_VARIANT_LABEL_LENGTH),
    /** Packages installed over the task's own, such as a framework build from a pull request. */
    packages: z
      .array(
        z
          .object({
            name: packageName,
            spec: packageSpec,
            /** Where under /app the package is installed, for a monorepo's workspace. */
            directory: z.union([appPath, z.literal("")]).default(""),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    /**
     * Files in /app: written (replace), added to (append), such as an AGENTS.md block that points
     * agents at docs, or removed (delete), such as AGENTS.md itself.
     */
    files: z
      .array(
        z
          .object({
            path: appPath,
            mode: z.enum(["replace", "append", "delete"]),
            content: z
              .string()
              .refine((text) => Buffer.byteLength(text) <= MAX_FILE_BYTES, "at most 64 KB")
              .default(""),
          })
          .strict()
          .transform((file) => (file.mode === "delete" ? { ...file, content: "" } : file)),
      )
      .max(10)
      .default([]),
  })
  .strict()
  .refine((environment) => environment.packages.length + environment.files.length > 0, {
    message: "an environment changes at least one package or file",
  });

export type EnvironmentSpec = z.infer<typeof environmentSchema>;

/** POST {repo}/environments: the changes, and the generation settings each task's check uses. */
export const environmentRequestSchema = z
  .object({ environment: environmentSchema, generation: z.unknown().optional() })
  .strict();

/**
 * The Dockerfile steps an environment adds after the author's own. They run before SelfBench commits
 * the task's starting tree (render.ts), so both images get them and they never reach the agent's
 * diff. Values are validated above and quoted, so none can break out of its shell word.
 */
function variantDockerfileSteps(environment: EnvironmentSpec): string {
  const steps = [`# SelfBench environment: ${environment.name.replace(/[\r\n]/g, " ")}`];
  for (const pkg of environment.packages) {
    const target = `'${pkg.name}@${pkg.spec}'`;
    const dir = pkg.directory ? `/app/${pkg.directory}` : "/app";
    const has = (file: string) => `{ [ -f ${file} ] || [ -f /app/${file} ]; }`;
    steps.push(
      `RUN cd ${dir} && export YARN_ENABLE_IMMUTABLE_INSTALLS=false && ` +
        `if ${has("pnpm-lock.yaml")}; then pnpm add ${target}; ` +
        `elif ${has("yarn.lock")}; then yarn add ${target}; ` +
        `elif ${has("bun.lock")} || ${has("bun.lockb")}; then bun add ${target}; ` +
        `else npm install ${target}; fi`,
    );
  }
  for (const file of environment.files) {
    const path = `/app/${file.path}`;
    if (file.mode === "delete") {
      steps.push(`RUN rm -rf -- ${path}`);
      continue;
    }
    const encoded = Buffer.from(file.content).toString("base64");
    steps.push(
      `RUN mkdir -p "$(dirname ${path})" && printf %s '${encoded}' | base64 -d ${file.mode === "append" ? ">>" : ">"} ${path}`,
    );
  }
  return `${steps.join("\n")}\n`;
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

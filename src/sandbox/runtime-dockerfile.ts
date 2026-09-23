import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "../lib/project-paths.js";

/** The packaged Dockerfile.sandbox split into its base image and the instructions after it. */
export interface SandboxDockerfile {
  readonly base: string;
  readonly instructions: readonly string[];
}

export function readSandboxDockerfile(root = projectRoot(import.meta.url)): string {
  return readFileSync(join(root, "Dockerfile.sandbox"), "utf8");
}

const references = new Map<string, string>();

/** Provenance for providers built straight from the file: its name plus a short content hash. */
export function sandboxDockerfileReference(root = projectRoot(import.meta.url)): string {
  let reference = references.get(root);
  if (!reference) {
    const digest = createHash("sha256").update(readSandboxDockerfile(root)).digest("hex");
    reference = `Dockerfile.sandbox@${digest.slice(0, 16)}`;
    references.set(root, reference);
  }
  return reference;
}

/**
 * For providers that start from a registry image and replay Dockerfile instructions (Modal).
 * Comments and blank lines are dropped; continuation lines stay with their instruction.
 */
export function parseSandboxDockerfile(dockerfile: string): SandboxDockerfile {
  const instructions: string[] = [];
  let current: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const trimmed = line.trim();
    if (current.length === 0 && (trimmed === "" || trimmed.startsWith("#"))) continue;
    current.push(line.trimEnd());
    if (!trimmed.endsWith("\\")) {
      instructions.push(current.join("\n"));
      current = [];
    }
  }
  if (current.length > 0) throw new Error("Dockerfile.sandbox ends inside a continued instruction");
  const [first, ...rest] = instructions;
  const from = first?.match(/^FROM\s+(\S+)$/i);
  if (!from?.[1]) throw new Error("Dockerfile.sandbox must start with a single-stage FROM <image>");
  if (rest.some((instruction) => /^FROM\s/i.test(instruction)))
    throw new Error("Dockerfile.sandbox must be single-stage");
  return { base: from[1], instructions: rest };
}

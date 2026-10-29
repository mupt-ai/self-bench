import { posix } from "node:path";
import { z } from "zod";
import { shellQuote } from "../../lib/util.js";
import type { Submission } from "./submission.js";

/** What a conversion reads of a definition.json, the format authors wrote before native files. */
export const legacyDefinitionSchema = z.object({
  difficulty: z.enum(["easy", "medium", "hard"]),
  repo: z.string(),
  baseCommit: z.string(),
  sourcePr: z.number(),
  workdir: z.string(),
  testCommand: z.string(),
  failToPass: z.array(z.string()),
  passToPass: z.array(z.string()),
  environment: z.object({
    baseImage: z.string(),
    rootSetupCommand: z.string(),
    setupCommand: z.string(),
    smokeCommand: z.string(),
    environmentVariables: z.record(z.string(), z.string()),
    services: z.array(z.unknown()),
  }),
});

export type LegacyDefinition = z.infer<typeof legacyDefinitionSchema>;

/** The files of a legacy compiled task a conversion carries over as they are. */
export interface LegacyFiles {
  readonly instruction: string;
  readonly testPatch: string;
  readonly goldPatch: string;
}

/**
 * A legacy task as the native files an author writes today. The Dockerfile repeats the legacy
 * compiler's steps: the pinned base image, the root setup, the variables, the snapshot in /app,
 * then the setup from the workdir. The tests run as the legacy verifier ran them. Services have
 * no native equivalent the conversion can write, so a task with any is the reason returned.
 */
export function legacySubmission(
  definition: LegacyDefinition,
  files: LegacyFiles,
): Submission | { readonly reason: string } {
  const { environment } = definition;
  if (environment.services.length > 0) {
    return { reason: "it declares services, which now run inside its image (services.sh)" };
  }
  const workdir = posix.join("/app", definition.workdir);
  const tests = (selectors: readonly string[]) =>
    definition.testCommand.replaceAll("{tests}", selectors.map(shellQuote).join(" "));
  const variables = Object.entries(environment.environmentVariables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `ENV ${name}=${JSON.stringify(value)}`);
  return {
    "instruction.md": files.instruction,
    Dockerfile: `${[
      `FROM ${environment.baseImage}`,
      `RUN ${JSON.stringify(["/bin/sh", "-eu", "-c", environment.rootSetupCommand])}`,
      ...variables,
      "ADD repo.tar.gz /app/",
      `WORKDIR ${workdir}`,
      `RUN ${JSON.stringify(["bash", "-euo", "pipefail", "-c", environment.setupCommand])}`,
    ].join("\n")}\n`,
    "smoke.sh": `set -euo pipefail\ncd ${shellQuote(workdir)}\n${environment.smokeCommand.trim()}\n`,
    "run-tests.sh": `cd ${shellQuote(workdir)}
case "$1" in
  fail-to-pass) ${tests(definition.failToPass)} ;;
  pass-to-pass) ${definition.passToPass.length > 0 ? tests(definition.passToPass) : "true"} ;;
  *) echo "usage: run-tests.sh fail-to-pass|pass-to-pass" >&2; exit 2 ;;
esac
`,
    "test.patch": files.testPatch,
    "gold.patch": files.goldPatch,
    "services.sh": "",
  };
}

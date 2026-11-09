import { readFile } from "node:fs/promises";
import type { VariantItem } from "../../contracts/variants.js";
import { requestJson } from "./api-client.js";
import { flag, jsonOption, list, parse, positional, repositoryPath, taskPath } from "./args.js";
import { GENERATION, generation } from "./generation.js";
import { print, table } from "./output.js";

const FLAGS = {
  ...GENERATION,
  label: { type: "string" },
  package: { type: "string", multiple: true },
  directory: { type: "string" },
  file: { type: "string", multiple: true },
  replace: { type: "boolean", default: false },
  variant: { type: "string" },
} as const;

/**
 * `task variant create|list|cancel|delete RUN_ID TASK_ID [VARIANT_RUN]`: an accepted task with
 * only its environment changed, checked once and reported beside the task (task-variants.ts).
 */
export async function variantCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  const { values, positionals } = parse(rest, FLAGS);
  const repository = repositoryPath(values);
  const runId = positional(positionals, 0, "RUN_ID");
  const taskId = positional(positionals, 1, "TASK_ID");
  const base = `${taskPath(repository, runId, taskId)}/variants`;
  switch (action) {
    case "create": {
      const reply = await requestJson(base, "POST", {
        variant: await variantFromFlags(values),
        ...(await generation(values, repository)),
      });
      const variant = reply.variant as VariantItem;
      return print(values, reply, () => `Started ${variant.runId} (${variant.label}).`);
    }
    case "list": {
      const reply = await requestJson(base);
      return print(values, reply, () =>
        table(reply.variants as VariantItem[], [
          ["VARIANT", (variant) => variant.runId],
          ["LABEL", (variant) => variant.label],
          ["STATE", (variant) => variant.state],
          ["NOTE", (variant) => variant.reasonSummary],
        ]),
      );
    }
    case "cancel":
    case "delete": {
      const variantRun = positional(positionals, 2, "VARIANT_RUN");
      const path = `${base}/${encodeURIComponent(variantRun)}`;
      return print(
        values,
        action === "cancel"
          ? await requestJson(`${path}/cancel`, "POST")
          : await requestJson(path, "DELETE"),
      );
    }
    default:
      throw new Error(
        "usage: self-bench task variant create|list|cancel|delete RUN_ID TASK_ID [VARIANT_RUN] --repo R",
      );
  }
}

/**
 * The variant `--variant JSON|@FILE` gives whole, or `--label` with `--package NAME@SPEC` and
 * `--file DEST=SOURCE`, each repeatable: packages install under `--directory`, and files append
 * unless `--replace`.
 */
async function variantFromFlags(values: Parameters<typeof flag>[0]): Promise<unknown> {
  const whole = await jsonOption(values, "variant");
  if (whole !== undefined) return whole;
  const label = flag(values, "label");
  if (!label) throw new Error("task variant create needs --label, or --variant JSON|@FILE");
  const directory = flag(values, "directory") ?? "";
  const packages = list(values, "package").map((given) => {
    // A scoped name starts with @, so the version follows the last @.
    const at = given.lastIndexOf("@");
    if (at < 1) throw new Error(`--package must be NAME@SPEC: ${given}`);
    return { name: given.slice(0, at), spec: given.slice(at + 1), directory };
  });
  const mode = values.replace === true ? "replace" : "append";
  const files = await Promise.all(
    list(values, "file").map(async (given) => {
      const at = given.indexOf("=");
      if (at < 1) throw new Error(`--file must be DEST=SOURCE: ${given}`);
      return {
        path: given.slice(0, at),
        mode,
        content: await readFile(given.slice(at + 1), "utf8"),
      };
    }),
  );
  if (packages.length + files.length === 0)
    throw new Error("task variant create needs --package or --file, or --variant JSON|@FILE");
  return { label, packages, files };
}

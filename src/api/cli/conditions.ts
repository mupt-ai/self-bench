import { readFile } from "node:fs/promises";
import { flag, list, type Values } from "./args.js";

/**
 * `--condition JSON|@FILE`, repeatable: each an object `{name, skills?, instructions?,
 * environment?, harnessOptions?}`, or a file holding one or a list. `--harness-option
 * HARNESS.OPTION=VALUE`, repeatable, adds one more condition that sets those options, named by
 * `--options-name`. `--no-baseline` runs only the conditions.
 */
export async function conditionsFromFlags(values: Values): Promise<Record<string, unknown>> {
  const given = (
    await Promise.all(
      list(values, "condition").map(async (given) => {
        const text = given.startsWith("@") ? await readFile(given.slice(1), "utf8") : given;
        const parsed: unknown = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : [parsed];
      }),
    )
  ).flat();
  const options = await harnessOptionsFromFlags(list(values, "harness-option"));
  const conditions = options
    ? [
        ...given,
        { name: flag(values, "options-name") ?? "Harness Options", harnessOptions: options },
      ]
    : given;
  return {
    ...(conditions.length ? { conditions } : {}),
    ...(values["no-baseline"] === true ? { baseline: false } : {}),
  };
}

/**
 * `HARNESS.OPTION=VALUE` entries as a condition's harnessOptions. A value is read as JSON when it
 * is JSON (`30`, `true`, `{...}`) and as text otherwise, as Harbor reads its own `--ak`; `@FILE`
 * reads it from a file, such as a settings.json for Claude Code's `config`.
 */
export async function harnessOptionsFromFlags(
  entries: readonly string[],
): Promise<Record<string, Record<string, unknown>> | undefined> {
  if (!entries.length) return undefined;
  const options: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const match = /^([a-z0-9-]+)\.([a-z0-9_]+)=([\s\S]*)$/.exec(entry);
    if (!match) throw new Error(`--harness-option ${entry}: write HARNESS.OPTION=VALUE`);
    const [, harness = "", name = "", raw = ""] = match;
    const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
    let value: unknown = text;
    try {
      value = JSON.parse(text);
    } catch {}
    options[harness] = { ...options[harness], [name]: value };
  }
  return options;
}

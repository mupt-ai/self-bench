import { readFile } from "node:fs/promises";
import { harborAgentOptions } from "../../contracts/harbor-agent-options.js";
import { flag, list, type Values } from "./args.js";

/** A repeatable ID flag's values, as numbers. */
function ids(values: Values, name: string): number[] {
  return list(values, name).map((entry) => {
    if (!/^\d+$/.test(entry)) throw new Error(`--${name} ${entry}: write an ID`);
    return Number(entry);
  });
}

/**
 * What a comparison runs besides the tasks as they are: `--saved-harness ID` and `--environment
 * ID`, both repeatable, and every pair of the two. `--no-baseline` leaves out the tasks as they
 * are. Older flags still work: `--saved-condition ID[:ENVIRONMENT_ID]` (with `--subagent-credential
 * ID` in place of the harness's own), `--condition JSON|@FILE` writing one pair out, and
 * `--harness-option AGENT.OPTION=VALUE` adding one more that sets those options, named by
 * `--options-name`.
 */
export async function harnessesFromFlags(values: Values): Promise<Record<string, unknown>> {
  const harnesses = ids(values, "saved-harness");
  const environments = ids(values, "environment");
  const subagentCredentialId = flag(values, "subagent-credential");
  const saved = list(values, "saved-condition").map((entry) => {
    const match = /^(\d+)(?::(\d+))?$/.exec(entry);
    if (!match) throw new Error(`--saved-condition ${entry}: write ID or ID:ENVIRONMENT_ID`);
    return {
      saved: Number(match[1]),
      ...(match[2] ? { environment: Number(match[2]) } : {}),
      ...(subagentCredentialId ? { subagentCredentialId } : {}),
    };
  });
  if (subagentCredentialId && !saved.length)
    throw new Error(
      "--subagent-credential needs --saved-condition; a saved harness names its own credential",
    );
  const given = [
    ...saved,
    ...(
      await Promise.all(
        list(values, "condition").map(async (given) => {
          const text = given.startsWith("@") ? await readFile(given.slice(1), "utf8") : given;
          const parsed: unknown = JSON.parse(text);
          return Array.isArray(parsed) ? parsed : [parsed];
        }),
      )
    ).flat(),
  ];
  const options = await harnessOptionsFromFlags(list(values, "harness-option"));
  const conditions = options
    ? [...given, { name: flag(values, "options-name") ?? "Options", harnessOptions: options }]
    : given;
  return {
    ...(harnesses.length ? { harnesses } : {}),
    ...(environments.length ? { environments } : {}),
    ...(conditions.length ? { conditions } : {}),
    ...(values["no-baseline"] === true ? { baseline: false } : {}),
  };
}

/**
 * Whether an option is text, so a value such as `2.10` stays as written. Reads the generated list
 * alone, which keeps the CLI bundle free of the server's validation and model catalog.
 */
function textOption(harness: string, name: string): boolean {
  const options: Record<string, readonly { name: string; kind: string }[]> = harborAgentOptions;
  const option = options[harness]?.find((entry) => entry.name === name);
  return option?.kind === "string" || option?.kind === "enum";
}

/**
 * `AGENT.OPTION=VALUE` entries as a harness's harnessOptions. A text option's value is taken
 * as written; any other is read as JSON when it is JSON (`30`, `true`, `{...}`) and as text
 * otherwise, as Harbor reads its own `--ak`. `@FILE` reads it from a file, such as a settings.json
 * for Claude Code's `config`.
 */
export async function harnessOptionsFromFlags(
  entries: readonly string[],
): Promise<Record<string, Record<string, unknown>> | undefined> {
  if (!entries.length) return undefined;
  const options: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const match = /^([a-z0-9-]+)\.([a-z0-9_]+)=([\s\S]*)$/.exec(entry);
    if (!match) throw new Error(`--harness-option ${entry}: write AGENT.OPTION=VALUE`);
    const [, harness = "", name = "", raw = ""] = match;
    const text = raw.startsWith("@") ? await readFile(raw.slice(1), "utf8") : raw;
    let value: unknown = text;
    if (!textOption(harness, name))
      try {
        value = JSON.parse(text);
      } catch {}
    options[harness] = { ...options[harness], [name]: value };
  }
  return options;
}

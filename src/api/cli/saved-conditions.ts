import { requestJson } from "./api-client.js";
import { flag, jsonOption, list, org, parse, positional, textOption, type Values } from "./args.js";
import { harnessOptionsFromFlags } from "./conditions.js";
import { print, table } from "./output.js";

const FLAGS = {
  name: { type: "string" },
  harness: { type: "string" },
  skill: { type: "string", multiple: true },
  instructions: { type: "string" },
  "instructions-file": { type: "string" },
  "harness-option": { type: "string", multiple: true },
  "subagent-model": { type: "string" },
  "subagent-prompt": { type: "string" },
  "subagent-prompt-file": { type: "string" },
  condition: { type: "string" },
} as const;

interface Saved {
  id: number;
  name: string;
  skills: string[];
  instructions?: string;
  harnessOptions?: Record<string, Record<string, unknown>>;
  subagent?: { catalogId: string; prompt: string };
}

/** What a saved condition changes, in a few words. */
function changes(condition: Saved): string {
  const options = Object.values(condition.harnessOptions ?? {}).flatMap(Object.keys).length;
  return [
    condition.skills.length ? `${condition.skills.length} skills` : "",
    condition.instructions ? "instructions" : "",
    options ? `${options} harness options` : "",
    condition.subagent ? `subagents on ${condition.subagent.catalogId}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * `conditions`; `condition create|show|update|delete [ID]`: the workspace's saved conditions
 * (routes/conditions.ts), which `compare --saved-condition ID` runs.
 */
export async function savedConditionCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, FLAGS);
  const base = `/api/orgs/${encodeURIComponent(org(values))}/conditions`;
  const one = () => `${base}/${encodeURIComponent(positional(positionals, 0, "ID"))}`;
  const shown = (reply: Record<string, unknown>) => {
    const condition = reply.condition as Saved;
    return `${condition.name} (${condition.id}): ${changes(condition)}`;
  };
  switch (action) {
    case "list": {
      const reply = await requestJson(base);
      return print(values, reply, () =>
        table(reply.conditions as Saved[], [
          ["ID", (condition) => condition.id],
          ["NAME", (condition) => condition.name],
          ["CHANGES", changes],
        ]),
      );
    }
    case "create": {
      const reply = await requestJson(base, "POST", await conditionFromFlags(values));
      return print(values, reply, () => shown(reply));
    }
    case "update": {
      const reply = await requestJson(one(), "PUT", await conditionFromFlags(values));
      return print(values, reply, () => shown(reply));
    }
    case "show": {
      const reply = await requestJson(one());
      return print(values, reply, () => shown(reply));
    }
    case "delete":
      return print(values, await requestJson(one(), "DELETE"));
    default:
      throw new Error("usage: self-bench conditions | condition create|show|update|delete [ID]");
  }
}

/**
 * A saved condition from `--condition JSON|@FILE`, or from `--name` with `--harness`, `--skill`,
 * `--instructions[-file]`, `--harness-option HARNESS.OPTION=VALUE`, and `--subagent-model ID` with
 * `--subagent-prompt[-file]` (an empty prompt tells the harness nothing; none, the default).
 */
async function conditionFromFlags(values: Values): Promise<unknown> {
  const written = await jsonOption(values, "condition");
  if (written !== undefined) return written;
  const name = flag(values, "name");
  if (!name) throw new Error("a condition needs --name, or --condition JSON|@FILE");
  const instructions = await textOption(values, "instructions");
  const harnessOptions = await harnessOptionsFromFlags(list(values, "harness-option"));
  const catalogId = flag(values, "subagent-model");
  const prompt = await textOption(values, "subagent-prompt");
  if (prompt !== undefined && !catalogId)
    throw new Error("--subagent-prompt needs --subagent-model");
  const harness = flag(values, "harness");
  return {
    name,
    ...(harness ? { harness } : {}),
    skills: list(values, "skill"),
    ...(instructions ? { instructions } : {}),
    ...(harnessOptions ? { harnessOptions } : {}),
    ...(catalogId ? { subagent: { catalogId, ...(prompt !== undefined ? { prompt } : {}) } } : {}),
  };
}

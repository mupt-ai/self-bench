import { requestJson } from "./api-client.js";
import { flag, jsonOption, list, org, parse, positional, textOption, type Values } from "./args.js";
import { harnessOptionsFromFlags } from "./harness-flags.js";
import { print, table } from "./output.js";

const FLAGS = {
  name: { type: "string" },
  agent: { type: "string" },
  skill: { type: "string", multiple: true },
  instructions: { type: "string" },
  "instructions-file": { type: "string" },
  option: { type: "string", multiple: true },
  "subagent-model": { type: "string" },
  "subagent-prompt": { type: "string" },
  "subagent-prompt-file": { type: "string" },
  "subagent-credential": { type: "string" },
  body: { type: "string" },
  // What these were before saved conditions were harnesses, still taken.
  harness: { type: "string" },
  "harness-option": { type: "string", multiple: true },
  condition: { type: "string" },
} as const;

interface Saved {
  id: number;
  name: string;
  agent?: string;
  skills: string[];
  instructions?: string;
  harnessOptions?: Record<string, Record<string, unknown>>;
  subagent?: { catalogId: string; prompt: string; credentialId?: string };
}

/** What a saved harness changes, in a few words. */
function changes(harness: Saved): string {
  const options = Object.values(harness.harnessOptions ?? {}).flatMap(Object.keys).length;
  return [
    harness.agent ?? "",
    harness.skills.length ? `${harness.skills.length} skills` : "",
    harness.instructions ? "instructions" : "",
    options ? `${options} options` : "",
    harness.subagent ? `subagents on ${harness.subagent.catalogId}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * `harnesses`; `harness create|show|update|delete [ID]`: the workspace's saved harnesses
 * (routes/saved-harnesses.ts), which `compare --saved-harness ID` runs. `conditions` and
 * `condition`, their older names, run the same commands.
 */
export async function savedHarnessCommand(args: string[], listing: boolean): Promise<void> {
  const [action, ...rest] = listing ? ["list", ...args] : args;
  const { values, positionals } = parse(rest, FLAGS);
  const base = `/api/orgs/${encodeURIComponent(org(values))}/harnesses`;
  const one = () => `${base}/${encodeURIComponent(positional(positionals, 0, "ID"))}`;
  const shown = (reply: Record<string, unknown>) => {
    const harness = reply.harness as Saved;
    return `${harness.name} (${harness.id}): ${changes(harness)}`;
  };
  switch (action) {
    case "list": {
      const reply = await requestJson(base);
      return print(values, reply, () =>
        table(reply.harnesses as Saved[], [
          ["ID", (harness) => harness.id],
          ["NAME", (harness) => harness.name],
          ["CHANGES", changes],
        ]),
      );
    }
    case "create": {
      const reply = await requestJson(base, "POST", await harnessFromFlags(values));
      return print(values, reply, () => shown(reply));
    }
    case "update": {
      const reply = await requestJson(one(), "PUT", await harnessFromFlags(values));
      return print(values, reply, () => shown(reply));
    }
    case "show": {
      const reply = await requestJson(one());
      return print(values, reply, () => shown(reply));
    }
    case "delete":
      return print(values, await requestJson(one(), "DELETE"));
    default:
      throw new Error("usage: self-bench harnesses | harness create|show|update|delete [ID]");
  }
}

/**
 * A saved harness from `--body JSON|@FILE`, or from `--name` with `--agent`, `--skill`,
 * `--instructions[-file]`, `--option AGENT.OPTION=VALUE`, and `--subagent-model ID` with
 * `--subagent-prompt[-file]` (an empty prompt tells the agent nothing; none, the default) and
 * `--subagent-credential ID` (the first that serves it, without one).
 */
async function harnessFromFlags(values: Values): Promise<unknown> {
  const written = (await jsonOption(values, "body")) ?? (await jsonOption(values, "condition"));
  if (written !== undefined) return written;
  const name = flag(values, "name");
  if (!name) throw new Error("a harness needs --name, or --body JSON|@FILE");
  const instructions = await textOption(values, "instructions");
  const harnessOptions = await harnessOptionsFromFlags([
    ...list(values, "option"),
    ...list(values, "harness-option"),
  ]);
  const catalogId = flag(values, "subagent-model");
  const prompt = await textOption(values, "subagent-prompt");
  const credentialId = flag(values, "subagent-credential");
  if ((prompt !== undefined || credentialId) && !catalogId)
    throw new Error("--subagent-prompt and --subagent-credential need --subagent-model");
  const agent = flag(values, "agent") ?? flag(values, "harness");
  return {
    name,
    ...(agent ? { agent } : {}),
    skills: list(values, "skill"),
    ...(instructions ? { instructions } : {}),
    ...(harnessOptions ? { harnessOptions } : {}),
    ...(catalogId
      ? {
          subagent: {
            catalogId,
            ...(prompt !== undefined ? { prompt } : {}),
            ...(credentialId ? { credentialId } : {}),
          },
        }
      : {}),
  };
}
